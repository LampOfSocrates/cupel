// Backend URL is a hand-edited constant in Phase 1 (skein-phases.md:10).
// The configurable switcher is Phase 2 (feature-spec.md:158).
//
// P1-TDEPLOY: production builds are served BY the mock from the same origin
// (docs/deployment.md:4 "One Docker container: FastAPI mock serves the API
// AND the built Vite bundle"), so BASE is "" there — all calls stay relative.
// import.meta.env.PROD is Vite's statically-replaced build flag (true only
// in `vite build`); dev server and vitest keep hitting the mock on :4010.
export const BASE = import.meta.env.PROD ? "" : "http://localhost:4010";
