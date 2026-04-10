#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
MANIFEST_FILE="${ROOT_DIR}/packaging/pi-packages.sources.tsv"
LOCK_FILE="${ROOT_DIR}/packaging/pi-packages.lock.tsv"

TMP_FILE=''

cleanup() {
    [[ -n "${TMP_FILE}" ]] && rm -f "${TMP_FILE}"
}

TMP_FILE="$(mktemp)"
trap cleanup EXIT INT QUIT TERM

printf '# repo\tcommit\n' > "${TMP_FILE}"

while IFS=$'\t' read -r repo _path _dest _filename; do
    if [[ -z "${repo}" || "${repo}" == \#* ]]; then
        continue
    fi

    printf '%s\n' "${repo}"
done < "${MANIFEST_FILE}" | sort -u | while IFS= read -r repo; do
    default_branch="$(gh api "repos/${repo}" --jq '.default_branch')"
    commit_sha="$(gh api "repos/${repo}/commits/${default_branch}" --jq '.sha')"
    printf '%s\t%s\n' "${repo}" "${commit_sha}" >> "${TMP_FILE}"
done

mv "${TMP_FILE}" "${LOCK_FILE}"
trap - EXIT
echo "Updated ${LOCK_FILE}"
