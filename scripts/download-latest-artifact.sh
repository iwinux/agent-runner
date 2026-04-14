#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
OUTPUT_DIR="${1:-${ROOT_DIR}/pi-bundle}"
REPO="${GITHUB_REPOSITORY:-$(gh repo view --json nameWithOwner --jq '.nameWithOwner')}"

HASH="$(cat "${ROOT_DIR}/packaging/pi-packages.sources.tsv" "${ROOT_DIR}/packaging/pi-packages.lock.tsv" | sha256sum | cut -d' ' -f1)"
ARTIFACT_NAME="pi-bundle-${HASH}"
ARTIFACT_URI="repos/${REPO}/actions/artifacts?name=${ARTIFACT_NAME}"
RUN_ID="$(gh api "${ARTIFACT_URI}" --jq '.artifacts[] | select(.expired == false) | .workflow_run.id' | head -n1 || true)"

if [[ -z "${RUN_ID}" ]]; then
    echo "artifact not found: ${ARTIFACT_NAME}" >&2
    exit 1
fi

gh run download "${RUN_ID}" --repo "${REPO}" --name "${ARTIFACT_NAME}" --dir "${OUTPUT_DIR}"
echo "artifact downloaded: ${ARTIFACT_NAME} -> ${OUTPUT_DIR}"
