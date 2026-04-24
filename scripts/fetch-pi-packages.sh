#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
MANIFEST_FILE="${ROOT_DIR}/packaging/pi-packages.sources.tsv"
LOCK_FILE="${ROOT_DIR}/packaging/pi-packages.lock.tsv"
OUTPUT_DIR="${ROOT_DIR}/pi-bundle"

declare -A REPO_COMMITS=()

while IFS=$'\t' read -r repo commit; do
    if [[ -z "${repo}" || "${repo}" == \#* ]]; then
        continue
    fi

    if [[ "${commit}" == "HEAD" ]]; then
        echo "ERROR: ${LOCK_FILE} still contains HEAD for ${repo}. Run scripts/update-pi-package-lock.sh first." >&2
        exit 1
    fi

    REPO_COMMITS["${repo}"]="${commit}"
done < "${LOCK_FILE}"

WORKDIR=''

cleanup() {
    [[ -n "${WORKDIR}" ]] && rm -rf "${WORKDIR}"
}

WORK_DIR="$(mktemp -d)"
trap cleanup EXIT INT QUIT TERM
mkdir -p "${WORK_DIR}/extensions" "${WORK_DIR}/themes"

while IFS=$'\t' read -r repo path dest_dir filename; do
    if [[ -z "${repo}" || "${repo}" == \#* ]]; then
        continue
    fi

    commit_sha="${REPO_COMMITS[${repo}]:-}"

    if [[ -z "${commit_sha}" ]]; then
        echo "ERROR: lock entry for ${repo} missing" >&2
        exit 1
    fi

    curl -fsSL \
        -o "${WORK_DIR}/${dest_dir}/${filename}" \
        "https://raw.githubusercontent.com/${repo}/${commit_sha}/${path}"
done < "${MANIFEST_FILE}"

cp "${MANIFEST_FILE}" "${WORK_DIR}/manifest.tsv"
cp "${LOCK_FILE}" "${WORK_DIR}/lock.tsv"

rm -rf "${OUTPUT_DIR}"
mv "${WORK_DIR}" "${OUTPUT_DIR}"
trap - EXIT

echo "pi-bundle packages fetched: ${OUTPUT_DIR}"
