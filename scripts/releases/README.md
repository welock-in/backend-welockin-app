# Windows release records

These immutable manifests and the adjacent release scripts were consolidated
from `ops/windows-release-0.3.49` (`c4667632cb886e1b12bd0c3d883738cae28b8737`).
They retain the published 0.3.46–0.3.49 artifact sizes, hashes and source revisions.
They are not instructions to republish those versions.

The former `vercel-build` publication hook is deliberately absent. Normal backend
builds and deployments must not publish a Windows release. `npm run test:release`
only runs isolated tests with fake service boundaries.

For a separately authorized release, review and update the release contract and
manifest for the intended new version, then run the backend preflight before the
publisher. The publisher does not invoke that preflight itself. Never bypass a
failed preflight or repoint a historical manifest at a newer commit to make it pass.
The existing 0.3.49 preflight pins backend `dcb2c4658c71eb24b31c62c784b1a41707773fb4`
and Windows `8656b34e30e0ab5057e60e5c0504b603d89f8fed`; a later backend deployment
is expected to fail that historical check.

Archived branch tips before consolidation:

| Branch | Commit |
| --- | --- |
| `ops/windows-release-0.3.46` | `8b2fda73d4b90c2eff7f3c37c903be7fbfc84bb1` |
| `ops/windows-release-0.3.47` | `e21c66ccb610b9ff29b8f02c75713661b4f0a153` |
| `ops/windows-release-0.3.48` | `e049decb347795ef8460394b66e22f7b2da8482d` |
| `ops/windows-release-0.3.49` | `c4667632cb886e1b12bd0c3d883738cae28b8737` |

The older branches' lifetime documentation is superseded by the current backend
documentation and payment safeguards. Consolidation does not restore old routes
or change purchase ownership, subscriptions, or entitlement behavior.

## Windows 0.3.51

The reviewed installer source is `dc64a1906b8ba3ad2dc014d875ab2a87e1d4a6c6`, with backend preflight pinned to `2c35cbc31132a5f19b83e67bd9d798a9d4885339`. The immutable manifest `windows-0.3.51.json` keeps rollout at zero: direct manual installation only, after all focus sessions end. It includes the session picker and quiet notification changes. Historical manifests and their source pins remain unchanged.
