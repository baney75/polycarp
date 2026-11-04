#!/bin/bash
set -e

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR"


case "$1" in
dev)
    echo "Starting dev server at http://localhost:8080"
    npx vite --config infra/vite.config.ts
    ;;

build)
    echo "Building static site..."
    npx vite build --config infra/vite.config.ts
    echo "Done. Output in dist/"
    ;;

deploy)
    # The upstream target was Sitegeist's own server. Tabkyra has no hosting yet:
    # build, then publish dist/ wherever the site should live.
    echo "No deploy target is configured for Tabkyra. Run '$0 build' and publish dist/." >&2
    exit 1
    ;;

*)
    echo "Usage: $0 {dev|build|deploy}"
    exit 1
    ;;
esac
