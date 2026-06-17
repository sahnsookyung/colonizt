#!/usr/bin/env bash
set -euo pipefail

npm run scan:branding
npm run lint
npm run typecheck
npm run test:unit
npm run test:property
npm run test:integration
npm run smoke:network
npm run simulate:ranked
npm run simulate:rush
npm --workspace @colonizt/web run test
npm run replay:fixtures
npm run build
