#!/usr/bin/env bash
# Print the linux/amd64 image-manifest digest that a registry reference resolves
# to, i.e. the digest Cloud Run actually runs and reports for a revision.
#
# Why not `docker inspect --format '{{index .RepoDigests 0}}'`: what that returns
# depends on the BUILDER's Docker. With the classic image store it is the image
# manifest; with the containerd image store (ubuntu-26.04 runners, newer Docker)
# `docker build` pushes a manifest LIST (the image plus a provenance attestation)
# and RepoDigests is the list's digest. Cloud Run resolves a list to the
# platform manifest, so the deploy's verify step compared two different digests
# and failed on a correctly deployed image. Asking the registry and selecting
# linux/amd64 gives the same answer from any builder.
#
# Usage: scripts/image-platform-digest.sh REGISTRY/PATH:TAG
# Needs: docker (with registry auth configured) and jq.
set -euo pipefail

ref="${1:?usage: $0 IMAGE_REF}"
# CI passes a ref read from the PR's Dockerfile: allow only image-reference
# characters, and end option parsing so it can never be read as a docker flag.
if ! [[ "${ref}" =~ ^[A-Za-z0-9][A-Za-z0-9._/:@-]*$ ]]; then
  echo "not an image reference: ${ref}" >&2
  exit 1
fi
manifest=$(docker manifest inspect --verbose -- "${ref}")
digest=$(jq -r '
  if type == "array" then
    [.[] | select(.Descriptor.platform.os == "linux" and .Descriptor.platform.architecture == "amd64")]
    | .[0].Descriptor.digest // empty
  else
    .Descriptor.digest // empty
  end' <<<"${manifest}")

if ! [[ "${digest}" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  echo "could not resolve a linux/amd64 manifest digest for ${ref}" >&2
  exit 1
fi
echo "${digest}"
