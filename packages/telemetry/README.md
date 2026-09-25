# Hydro telemetry contracts

`@earendil-works/pi-telemetry` contains the small, vendor-neutral types used by the AI
runtime for request and span metadata. Hydro does not require a telemetry backend; the no-op
context is the default and the in-memory context is useful in tests.

```ts
import { NOOP_TELEMETRY_CONTEXT } from "@earendil-works/pi-telemetry";
```

The `@earendil-works/pi-telemetry/testing` entry point exports the conformance helpers used by
the package tests. The package is built and tested from the repository workspace and is not a
standalone Hydro service.
