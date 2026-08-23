#!/usr/bin/env bash
# Cigna coverage policies are copyrighted (unlike public-domain CMS documents),
# so the CIGNA-0158 fixture PDF is fetched, never committed. Stable static
# URL verified 2026-08-22. Extraction pins sourceHash, so an upstream policy
# revision surfaces as a hash change, not silent drift.
set -euo pipefail
cd "$(dirname "$0")/.."
url='https://static.cigna.com/assets/chcp/pdf/coveragePolicies/medical/mm_0158_coveragepositioncriteria_obstructive_sleep_apnea_diag_trtment_svc.pdf'
out='fixtures/CIGNA-0158.pdf'
curl -fL --retry 3 -o "$out" "$url"
echo "fetched $out"
