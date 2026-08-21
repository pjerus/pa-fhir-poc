#!/usr/bin/env bash
# Fetch the pinned official HL7 FHIR validator jar into tools/ (gitignored).
# The jar version is pinned here and only here.
set -euo pipefail

VALIDATOR_VERSION="6.10.2"
URL="https://github.com/hapifhir/org.hl7.fhir.core/releases/download/${VALIDATOR_VERSION}/validator_cli.jar"
DEST="$(cd "$(dirname "$0")" && pwd)/validator_cli.jar"

if [[ -f "$DEST" ]]; then
  echo "Already present: $DEST"
else
  echo "Downloading validator_cli.jar ${VALIDATOR_VERSION} ..."
  curl -fL --retry 3 -o "$DEST" "$URL"
fi

echo "sha256: $(shasum -a 256 "$DEST" | cut -d' ' -f1)"
echo "version pin: ${VALIDATOR_VERSION}"
