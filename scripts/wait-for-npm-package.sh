#!/usr/bin/env bash
# Wait until an npm package spec can actually be INSTALLED, not merely seen.
#
#   scripts/wait-for-npm-package.sh engramgraph@0.17.0
#
# Used by .github/workflows/release-compat-check.yml (XSPEC-365 R6 follow-up,
# dev-platform #307). It exits 0 once the spec's tarball answers a HEAD request
# with a 2xx, and writes `package-spec=<spec>` to $GITHUB_OUTPUT when that file
# is set. It exits 1 after the attempts run out, with the "NO platform was
# tested" error: nothing was installed, so nothing is known about any platform.
#
# WHY THE TARBALL AND NOT `npm view <spec> version`
#
# The registry serves the version METADATA before it serves the package FILE.
# On 0.16.0 `npm view engramgraph@0.16.0 version` answered, the wait ended, and
# the very next `npm install` got a 404 for engramgraph-0.16.0.tgz: all four
# platforms went red and none had been verified (run 44994199862; the manual
# re-run 45132081307 on the same version was green). A wait that stops at the
# metadata reports "the platform is broken" for a package that was only not there
# yet — the confusion XSPEC-365 R6 exists to prevent. `dist.tarball` is the URL
# npm itself downloads, so asking it is asking the thing the install will ask.
#
# Environment (all optional; the defaults are what the workflow uses):
#   WAIT_ATTEMPTS   how many times to ask             (default 20)
#   WAIT_INTERVAL   seconds between asks              (default 15)
#   EVENT_NAME      only used to word the error
set -u

SPEC="${1:-}"
if [ -z "$SPEC" ]; then
  echo "usage: wait-for-npm-package.sh <package-spec>" >&2
  exit 2
fi
ATTEMPTS="${WAIT_ATTEMPTS:-20}"
INTERVAL="${WAIT_INTERVAL:-15}"

echo "Waiting for the package file of $SPEC to be downloadable from the npm registry..."
LAST="the registry does not list $SPEC yet"
for i in $(seq 1 "$ATTEMPTS"); do
  # `|| true`: a spec the registry has never heard of makes `npm view` exit non-zero; that is "not yet", not an error here.
  URL="$(npm view "$SPEC" dist.tarball 2>/dev/null | tail -n 1 || true)"
  if [ -z "$URL" ]; then
    LAST="the registry does not list $SPEC yet"
  elif curl --silent --show-error --fail --head --location --max-time 30 --output /dev/null "$URL" 2>/dev/null; then
    echo "Found $SPEC and its package file ($URL) after ~$(( (i - 1) * INTERVAL ))s."
    if [ -n "${GITHUB_OUTPUT:-}" ]; then
      echo "package-spec=$SPEC" >> "$GITHUB_OUTPUT"
    fi
    exit 0
  else
    LAST="the registry lists $SPEC but its package file ($URL) does not download yet (HEAD was refused)"
  fi
  echo "  attempt $i/$ATTEMPTS: $LAST, waiting ${INTERVAL}s..."
  if [ "$i" -lt "$ATTEMPTS" ]; then sleep "$INTERVAL"; fi
done

# TELL THE FAILURES APART (XSPEC-365 R6).
#
# "the package is not on the registry" and "a platform cannot install it" must
# not surface as the same red. A publish that FAILED never gets here
# (publish-not-succeeded reports it). Reaching this point means publish.yml
# succeeded, or a manual run named a version, and the registry still cannot hand
# out the package file. No platform was tested either way, so nothing about
# platform support follows.
echo "::error title=Version not visible on npm — NO platform was tested::" \
  "$SPEC could not be downloaded from the npm registry within $(( ATTEMPTS * INTERVAL / 60 )) minutes" \
  "(last answer: $LAST; event: ${EVENT_NAME:-unknown}). The matrix below did not run, so this release is UNVERIFIED" \
  "rather than broken. If this was a workflow_run, publish.yml reported success:" \
  "check npm's registry status; if it was a manual run, check the version you typed."
exit 1
