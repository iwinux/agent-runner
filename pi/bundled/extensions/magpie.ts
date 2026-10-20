/**
 * Magpie provider for pi (global extension).
 *
 * Registers a "magpie" model provider that talks to a magpie gateway:
 * - Auth by API key (gateway key), stored in auth.json via `/login magpie`.
 * - The gateway endpoint is resolved, in order, from:
 *     1. auth.json  — the credential's `env.MAGPIE_BASE_URL` (saved by the /login prompt)
 *     2. the MAGPIE_BASE_URL environment variable
 *     3. settings.json — `magpie.baseUrl` or `magpieBaseUrl` in settings.json
 *     4. the default local gateway, http://127.0.0.1:3425
 * - Models come from `<endpoint>/models`. The extension factory fetches them
 *   before pi finishes startup, so the provider is never registered empty:
 *   a session whose default model is a magpie one resolves like any other.
 *   When the gateway can't be reached (offline, down, bad key) the factory
 *   falls back to pi's persisted catalog for the provider, and `fetchModels`
 *   keeps the list fresh afterwards (also right after `/login magpie`).
 * - Each model is served on its native API, taken from the list's
 *   `native_endpoints`: Chat Completions and Responses at `<root>/v1`,
 *   Anthropic Messages at `<root>`. A model without a recognized
 *   `native_endpoints` entry falls back by family, as magpie's own
 *   heuristics do: `claude-*` on Anthropic Messages at `<root>`, `gemini-*`
 *   on the Gemini generateContent API at `<root>/v1beta` (but only the ids
 *   pi asks for a discrete thinkingLevel: see asksDiscreteGoogleThinking),
 *   anything else on Chat Completions at `<root>/v1`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import {
	anthropicMessagesApi,
	createProvider,
	googleGenerativeAIApi,
	openAICompletionsApi,
	openAIResponsesApi,
} from "@earendil-works/pi-ai";
import fs from "node:fs";
import path from "node:path";

const DEFAULT_ENDPOINT = "http://127.0.0.1:3425";
const ENDPOINT_ENV_KEY = "MAGPIE_BASE_URL";
const API_KEY_ENV_KEY = "MAGPIE_API_KEY";

/** How long startup waits on the gateway before using the cached list. */
const STARTUP_FETCH_TIMEOUT_MS = 5_000;

/** provider.PricesHeader: asks the model list what each model costs. */
const PRICES_HEADER = "X-Magpie-Prices";

type PiApi =
	| "openai-completions"
	| "openai-responses"
	| "anthropic-messages"
	| "google-generative-ai";

const PI_APIS: readonly PiApi[] = [
	"openai-completions",
	"openai-responses",
	"anthropic-messages",
	"google-generative-ai",
];

// What went wrong the last time the model list was fetched, which
// endpoint it was fetched from, and when it last succeeded — reported by
// /magpie, since the model picker only says "Could not refresh magpie"
// and drops the cause.
let lastError: string | undefined;
let lastSuccessAt: number | undefined;
let lastEndpoint: string | undefined;

interface MagpieModel {
	id: string;
	display_name?: string;
	magpie_label?: string;
	owned_by?: string;
	reasoning?: boolean;
	reasoning_levels?: string[];
	supported_reasoning_levels?: { effort: string }[];
	modalities?: { input?: string[]; output?: string[] };
	context_window?: number;
	context_length?: number;
	max_output_tokens?: number;
	native_endpoints?: string[];
	type?: string;
	kind?: string;
	/** What magpie counts a call at, USD per million tokens (X-Magpie-Prices). */
	magpie_price?: MagpiePrice;
}

/** catalog.Price: USD per million tokens, magpie's own field names. */
interface MagpiePrice {
	input?: number;
	output?: number;
	cache_read?: number;
	cache_write?: number;
	tiers?: {
		above?: number;
		input?: number;
		output?: number;
		cache_read?: number;
		cache_write?: number;
	}[];
}

const agentFile = (name: string) => path.join(getAgentDir(), name);

/** The `magpie` entry of ~/.pi/agent/auth.json, as /login magpie stores it. */
function readCredential(): { key?: string; env?: Record<string, string | undefined> } | undefined {
	try {
		const auth = JSON.parse(fs.readFileSync(agentFile("auth.json"), "utf8")) as Record<
			string,
			{ type?: string; key?: string; env?: Record<string, string | undefined> }
		>;
		const credential = auth?.magpie;
		if (!credential || credential.type !== "api_key") return undefined;
		return credential;
	} catch {
		return undefined;
	}
}

/** Endpoint settings stored outside auth.json: ~/.pi/agent/settings.json. */
function endpointFromSettings(): string | undefined {
	try {
		const settings = JSON.parse(fs.readFileSync(agentFile("settings.json"), "utf8")) as {
			magpie?: { baseUrl?: string };
			magpieBaseUrl?: string;
		};
		const base = settings.magpie?.baseUrl ?? settings.magpieBaseUrl;
		return typeof base === "string" && base.trim() ? base.trim() : undefined;
	} catch {
		return undefined;
	}
}

function resolveEndpoint(credentialEnv?: Record<string, string | undefined>): string {
	return (
		credentialEnv?.[ENDPOINT_ENV_KEY] ??
		process.env[ENDPOINT_ENV_KEY] ??
		endpointFromSettings() ??
		DEFAULT_ENDPOINT
	);
}

function resolveKey(credentialKey?: string): string | undefined {
	return credentialKey ?? process.env[API_KEY_ENV_KEY] ?? undefined;
}

/** Root of a gateway address: bare host:port becomes http://, a trailing /v1 is dropped. */
function gatewayRoot(endpoint: string): string {
	let root = endpoint.trim();
	if (root && !root.includes("://")) root = `http://${root}`;
	root = root.replace(/\/+$/, "");
	if (root.endsWith("/v1")) root = root.slice(0, -3);
	return root;
}

/** Map a magpie native endpoint to the pi API that speaks it. */
function endpointToApi(native: string): PiApi | undefined {
	if (native.endsWith("/v1/chat/completions")) return "openai-completions";
	if (native.endsWith("/v1/responses")) return "openai-responses";
	if (native.endsWith("/v1/messages")) return "anthropic-messages";
	return undefined;
}

/**
 * Fallback for a model the list says no native endpoint of: the API its
 * family is asked on, the way magpie's own per-client heuristics read a
 * bare model id ("claude-*", "gemini-*").
 */
function familyApi(model: MagpieModel): PiApi {
	const bare = model.id.slice(model.id.lastIndexOf("/") + 1).toLowerCase();
	if (bare.startsWith("claude")) return "anthropic-messages";
	if (bare.startsWith("gemini")) {
		return asksDiscreteGoogleThinking(bare) ? "google-generative-ai" : "openai-completions";
	}
	return "openai-completions";
}

/**
 * Whether pi's Google API asks this model for a discrete thinkingLevel. Its
 * rule, copied from usesGoogleThinkingLevel: Gemini 3 Pro/Flash (id with or
 * without a minor version) and Gemma 4. Every other Gemini id gets a -1
 * thinkingBudget, "the model decides", for *every* thinking level, which
 * magpie reads back as medium: asking those on the Gemini API would turn
 * "high" into "medium". Chat Completions carries the level, so they go
 * there and magpie fits it to the model's own levels.
 */
function asksDiscreteGoogleThinking(bare: string): boolean {
	return (
		/gemini-3(?:\.\d+)?-(?:pro|flash)/.test(bare) ||
		bare === "gemini-flash-latest" ||
		bare === "gemini-flash-lite-latest" ||
		/gemma-?4/.test(bare)
	);
}

/** Where pi asks each API on a magpie gateway rooted at root. */
function baseUrlFor(api: PiApi, root: string): string {
	switch (api) {
		case "anthropic-messages":
			return root; // the gateway serves /v1/messages at the root
		case "google-generative-ai":
			return `${root}/v1beta`; // the SDK appends /models/{model}:streamGenerateContent
		default:
			return `${root}/v1`; // the OpenAI SDKs append /chat/completions, /responses
	}
}

// magpie's effort rank, quietest first (none/minimal are not model levels).
const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

/** The efforts a model's list entry says it takes, quietest first. */
function supportedEfforts(model: MagpieModel): (typeof EFFORTS)[number][] {
	const efforts = (model.supported_reasoning_levels ?? model.reasoning_levels ?? [])
		.map((l) => (typeof l === "string" ? l : l?.effort))
		.filter((l): l is (typeof EFFORTS)[number] => EFFORTS.includes(l as never));
	const ranks = new Map(EFFORTS.map((e, i) => [e, i]));
	return [...new Set(efforts)].sort((a, b) => ranks.get(a)! - ranks.get(b)!);
}

/**
 * pi offers every level up to "high" on its own; "xhigh" and "max" it offers
 * only when the map names them (getSupportedThinkingLevels). So the map does
 * not remake magpie's choices: minimal/low/medium/high go as pi's level and
 * magpie fits it to the model's own levels (NearestEffort: nearest, a tie
 * going up), and xhigh/max are declared only where the model lists them.
 *
 * Two routes need care:
 * - Google speaks only MINIMAL..HIGH and pi throws on any other mapped value,
 *   so nothing is declared there and pi clamps xhigh/max to "high" itself.
 * - Anthropic Messages takes a thinking *budget*, not an effort: pi sends the
 *   budget for "high" for xhigh and max too (clampReasoning), and magpie's
 *   effortOfBudget reads it back as "high". Declaring them there would offer
 *   levels that never arrive, so it is left at "high". (compat
 *   forceAdaptiveThinking would send output_config.effort instead and keep
 *   them, but adaptive thinking is refused by Claude models older than 4.6.)
 *
 * "off" is declared as "none", magpie's word for reasoning turned off
 * (Chat Completions would otherwise send nothing at all and leave the
 * model's default thinking on).
 */
function thinkingLevelMap(model: MagpieModel, api: PiApi): Model["thinkingLevelMap"] {
	if (!model.reasoning) return undefined;
	if (api === "google-generative-ai") return undefined;
	const map: Record<string, string> = { off: "none" };
	const efforts = new Set(supportedEfforts(model));
	if (api !== "anthropic-messages") {
		for (const level of ["xhigh", "max"] as const) {
			if (efforts.has(level)) map[level] = level;
		}
	}
	return map;
}

const ZERO_COST: Model["cost"] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/**
 * pi's cost from magpie's price (USD per million tokens). magpie only tells
 * a price to a local caller or one carrying a gateway key, and only if the
 * request asks with X-Magpie-Prices; a model with no price stays at 0, as
 * pi knows nothing of what it costs.
 */
function toPiCost(price: MagpiePrice | undefined): Model["cost"] {
	if (!price) return ZERO_COST;
	const usd = (value: unknown): number =>
		typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
	const tiers = (Array.isArray(price.tiers) ? price.tiers : [])
		.filter((tier) => typeof tier?.above === "number")
		.map((tier) => ({
			inputTokensAbove: tier.above!,
			input: usd(tier.input),
			output: usd(tier.output),
			cacheRead: usd(tier.cache_read),
			cacheWrite: usd(tier.cache_write),
		}))
		.sort((a, b) => a.inputTokensAbove - b.inputTokensAbove);
	return {
		input: usd(price.input),
		output: usd(price.output),
		cacheRead: usd(price.cache_read),
		cacheWrite: usd(price.cache_write),
		...(tiers.length > 0 ? { tiers } : {}),
	};
}

function toPiModel(model: MagpieModel, root: string): Model<PiApi> | undefined {
	if (!model?.id || (model.type && model.type !== "model") || model.kind) return undefined;

	const native = model.native_endpoints ?? [];
	let api: PiApi | undefined;
	for (const endpoint of native) {
		const spoken = endpointToApi(endpoint);
		if (spoken) {
			api = spoken;
			break;
		}
	}
	api ??= familyApi(model);

	const input = (model.modalities?.input ?? []).filter((m) => m === "text" || m === "image");

	return {
		id: model.id,
		name: model.magpie_label ?? model.display_name ?? model.id,
		api,
		provider: "magpie",
		baseUrl: baseUrlFor(api, root),
		reasoning: !!model.reasoning,
		thinkingLevelMap: thinkingLevelMap(model, api),
		input: input.length > 0 ? input : ["text"],
		cost: toPiCost(model.magpie_price),
		contextWindow: model.context_window ?? model.context_length ?? 128000,
		maxTokens: model.max_output_tokens ?? 65536,
	};
}

/** GET <root>/models and map the list, throwing with the real cause on failure. */
async function fetchModelsFrom(
	root: string,
	endpoint: string,
	key: string | undefined,
	signal: AbortSignal,
): Promise<Model<PiApi>[]> {
	const headers = {
		...(key ? { Authorization: `Bearer ${key}` } : {}),
		// What magpie counts each call at; it tells only a local caller or one
		// with a gateway key, and only when asked.
		[PRICES_HEADER]: "1",
	};
	let response = await fetch(`${root}/models`, { headers, signal });
	if (response.status === 404) {
		// Older magpies and some proxies serve the list under /v1 only.
		response = await fetch(`${root}/v1/models`, { headers, signal });
	}
	if (!response.ok) {
		throw new Error(`HTTP ${response.status} from ${endpoint}/models${key ? "" : " (no API key sent)"}`);
	}
	const payload = (await response.json()) as { data?: MagpieModel[] };
	const models = (payload.data ?? [])
		.map((model) => toPiModel(model, root))
		.filter((model): model is Model<PiApi> => model !== undefined);
	if (models.length === 0) {
		throw new Error(`${endpoint}/models has no chat models`);
	}
	return models;
}

/**
 * pi's last persisted catalog for the provider (~/.pi/agent/models-store.json),
 * so startup has models even when the gateway is unreachable. baseUrl is
 * re-derived, as the endpoint may have changed since it was written.
 */
function storedModels(root: string): Model<PiApi>[] {
	try {
		const store = JSON.parse(fs.readFileSync(agentFile("models-store.json"), "utf8")) as Record<
			string,
			{ models?: unknown }
		>;
		const stored = store?.magpie?.models;
		if (!Array.isArray(stored)) return [];
		return (stored as Model<PiApi>[])
			.filter((model) => model && typeof model.id === "string" && PI_APIS.includes(model.api))
			.map((model) => ({ ...model, provider: "magpie", baseUrl: baseUrlFor(model.api, root) }));
	} catch {
		return [];
	}
}

function offline(): boolean {
	return !!process.env.PI_OFFLINE || process.argv.includes("--offline");
}

export default async function (pi: ExtensionAPI) {
	const credential = readCredential();
	const endpoint = resolveEndpoint(credential?.env);
	const key = resolveKey(credential?.key);
	const root = gatewayRoot(endpoint);

	// Seed the provider before pi continues startup: the network list when
	// the gateway answers, else pi's stored catalog. Registering an empty
	// provider races pi's own model restore and can leave the default model
	// "unknown" on the occasional startup.
	let models = storedModels(root);
	if (!offline()) {
		try {
			models = await fetchModelsFrom(root, endpoint, key, AbortSignal.timeout(STARTUP_FETCH_TIMEOUT_MS));
			lastSuccessAt = Date.now();
			lastError = undefined;
		} catch (error) {
			lastError = error instanceof Error ? error.message : String(error);
		}
	}
	lastEndpoint = endpoint;

	pi.registerProvider(
		createProvider<PiApi>({
			id: "magpie",
			name: "Magpie",
			baseUrl: root,
			auth: {
				apiKey: {
					name: "Magpie API key",
					async login(interaction) {
						const endpoint = (
							await interaction.prompt({
								type: "text",
								message: "Magpie gateway endpoint",
								placeholder: DEFAULT_ENDPOINT,
							})
						).trim();
						const key = (
							await interaction.prompt({
								type: "secret",
								message: "Magpie API key (gateway key)",
							})
						).trim();
						return {
							type: "api_key",
							key,
							env: endpoint ? { [ENDPOINT_ENV_KEY]: endpoint } : undefined,
						};
					},
					async resolve({ ctx, credential }) {
						const key = resolveKey(credential?.key) ?? (await ctx.env(API_KEY_ENV_KEY)) ?? undefined;
						if (!key) return undefined;
						return {
							auth: { apiKey: key },
							env: credential?.env,
							source: credential?.key ? "stored API key" : API_KEY_ENV_KEY,
						};
					},
				},
			},
			models,
			// One stream implementation per API a magpie model may speak.
			api: {
				"openai-completions": openAICompletionsApi(),
				"openai-responses": openAIResponsesApi(),
				"anthropic-messages": anthropicMessagesApi(),
				"google-generative-ai": googleGenerativeAIApi(),
			},
			async fetchModels(context) {
				try {
					const credential =
						context.credential?.type === "api_key" ? context.credential : undefined;
					const endpoint = resolveEndpoint(credential?.env);
					const root = gatewayRoot(endpoint);
					const key = resolveKey(credential?.key);
					const models = await fetchModelsFrom(root, endpoint, key, context.signal);
					lastError = undefined;
					lastSuccessAt = Date.now();
					lastEndpoint = endpoint;
					return models;
				} catch (error) {
					// The model picker only shows "Could not refresh magpie" and
					// drops the cause; keep it for /magpie to show.
					lastError = error instanceof Error ? error.message : String(error);
					throw error;
				}
			},
		}),
	);

	// /magpie reports what the model picker hides: the endpoint in use,
	// the model count, and the verbatim error of the last (and a fresh)
	// model-list fetch.
	pi.registerCommand("magpie", {
		description: "Magpie provider status: endpoint, models, refresh errors",
		async handler(_args, ctx) {
			const auth = await ctx.modelRegistry.getProviderAuth("magpie");
			const endpoint = lastEndpoint ?? auth?.env?.[ENDPOINT_ENV_KEY] ?? resolveEndpoint();
			const lines = [`endpoint ${endpoint}`];

			if (!auth) {
				lines.push("not signed in — run /login magpie");
				if (lastError) lines.push(`last refresh failed: ${lastError}`);
			} else {
				const result = await ctx.modelRegistry.refresh({ providers: ["magpie"] });
				const error = result?.errors.get("magpie");
				const count = ctx.modelRegistry.getAll().filter((m) => m.provider === "magpie").length;
				lines.push(`${count} models`);
				if (lastSuccessAt) lines.push(`last ok ${new Date(lastSuccessAt).toLocaleString()}`);
				if (error) {
					lines.push(`refresh failed: ${error instanceof Error ? error.message : String(error)}`);
					ctx.ui.notify(`magpie — ${lines.join(" · ")}`, "error");
					return;
				}
				if (result?.aborted) lines.push("refresh aborted");
			}
			ctx.ui.notify(`magpie — ${lines.join(" · ")}`, "info");
		},
	});
}
