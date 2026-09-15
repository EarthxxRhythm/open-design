# Disposable payload-factor experiment

Only `experiment/architecture-benefit-boundaries`; do not merge this workflow
replacement. Apple factor jobs have no R2/update/notification credentials.
The original release-beta four-round experiment remains unchanged.

## Purpose and limits

Attribute the residual native cost in the plan/blob four-minute delivery model.
Earlier full/minimal pairs changed file count, bytes, and native content together.
This experiment controls the first two while reusing identical Electron nested
signatures. This is a payload proxy, not full business-runtime acceptance.

Apple explicitly recommends minimizing file count, avoiding huge changing data
files and heavily compressed disk images, and excluding non-executable data from
notarization when possible:
https://developer.apple.com/documentation/security/customizing-the-notarization-workflow
Those recommendations support the hypothesis, not a linear cost coefficient.

## First screen (five submissions)

All samples come from the pinned SHA256 of the same v0.22.0 arm64 DMG.
Four samples share the same hidden renderer fixture and Electron binaries.

| Cell | Added data files | Added uncompressed bytes |
| --- | ---: | ---: |
| few-small | 1 | 8 MiB |
| many-small | 14,710 | 8 MiB |
| few-large | 1 | 688 MiB |
| many-large | 14,710 | 688 MiB |
| full | Unmodified released Resources | Measured actual content |

The first four use one identical run-seeded repetitive text stream, partitioned
at file boundaries. No executable code is added. High compressibility deliberately
reduces the confounding between upload size and uncompressed bytes. Actual ZIP
sizes are measured; this data family does not model every real asset entropy.
Signing seals grow with file count, so actual signed app bytes are also recorded;
equal raw payload bytes must not be advertised as exact equal post-sign app size.
Native Mach-O hashes/bytes/paths are reported to verify the common base and expose
extra native code in the full reference. Apple internal caching remains opaque.

## Measurements

Outer Developer ID signing with secure timestamp; strict signature verification;
hidden renderer smoke for proxies; files/bytes/native inventory; ZIP creation;
one upload/submit; wait on that exact ID; status/log; staple, ticket validation,
Gatekeeper. Only full/few-small also create a final DMG; the other three are
Apple factor probes, not complete distribution measurements. Never re-submit on
wait timeout. Only reports are retained, not apps/ZIPs/DMGs.

No automatic retry or second full matrix. Inspect the first screen, then select
only a pair that resolves ambiguity (`count-small`, `count-large`, `bytes-few`,
`bytes-many`, or `endpoints`). A single pair is not a percentile or universal law.
Respect Apple's 75/day guidance; the experiment starts with five submissions.

## Priority evidence chain

1. Check the controls (same base, data bytes/count, signatures, real acceptance).
2. Compare count at each size, size at each count, and their interaction.
3. Compare the real full app with the high-count/high-size proxy: differences
   cannot automatically be assigned to count/bytes when content/native code differ.
4. Combine with plan build/test and transfer observations only at matching stage
   boundaries. Native-base reuse is held fixed, not credited to plan or blob.
5. A composed 2×2 plan/blob DAG is a model until its corresponding delivery cells
   actually execute. Do not call these five notary probes four product releases,
   CDN-ready evidence, client installation proof, or a demonstrated 4-minute SLA.

Stop expanding probes when the evidence resolves priority, or explicitly report
that service variation prevents the requested inference. Formal startup/update,
reliability and implementation cost are separate design work, not prerequisites
for this payload-size experiment.

## Necessary alternative after first screen

First screen Apple wait: 36/83/43/181s across the factorial, real full 179s.
Add one `container` sample: retain all original real Resources bytes in an
uncompressed ASAR; keep every detected Mach-O loose and verify its unchanged
SHA256 before signing. Same Electron base; hidden fixture actually reads the
real archived package metadata. This is not full application compatibility
acceptance. It distinguishes in-bundle aggregation from external blob distribution
before attributing the lower file-count benefit to a larger architecture change.

## Externalization cost, without another notarization

`blob-transfer` downloads the same pinned reference once, archives its actual
Resources, writes exactly one immutable `dogfood/0.22.0-beta.<run>/architecture-blob-<attempt>/resources.tgz`
object, verifies CDN HEAD size, downloads and checks its whole SHA256, extracts it
and reads its real package metadata. Release storage credentials exist only on
this step; no production channel, pointer or workload-cache write is possible.
It measures externalization's archive/publication/first-acquire costs, not a
full client upgrade or four complete plan/blob factorial releases. CDN readiness
and consumer readiness are separate endpoints. No Apple credentials or submissions.
