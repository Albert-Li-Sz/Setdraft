# Hydro authoring core

This private workspace package owns the deterministic part of Hydro problem authoring: validating a normalized problem specification, materializing the official directory layout, and inspecting a prepared Hydro problem directory before export.

The package does not decide whether an algorithm is correct. Compilation, differential testing,
and optional live Hydro acceptance are separate server-side gates.
