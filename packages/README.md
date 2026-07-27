# Shared Packages

This directory is for code shared by multiple product surfaces.

Current package:
- `shared_core`: shared transcript pipeline facade

Migration rule:
- new desktop and web features should depend on `packages/shared_core`
- old root-level imports remain temporarily for backward compatibility
