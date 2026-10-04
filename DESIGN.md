# Setdraft UI design

This is Setdraft's workspace adaptation of the
[Cohere design analysis](https://getdesign.md/cohere/design-md) from
[VoltAgent/awesome-design-md](https://github.com/VoltAgent/awesome-design-md).
The original prompt is preserved in [docs/design/cohere.md](docs/design/cohere.md),
under the [upstream MIT notice](LICENSES/awesome-design-md.txt).
Use the rules below for the application; the upstream document supplies visual reference.

## Direction

Use editorial white space, mineral surfaces, deep green product areas, fine rules,
and restrained typography. Setdraft is a working authoring tool: dense editors,
test data and diagnostics remain practical, while entry pages have more breathing room.
Keep the Setdraft name, icons, navigation and problem-authoring terminology.

## Tokens

`packages/hydro-web/src/design-tokens.css` owns palette, fonts, radii and control sizes.
Component styles consume semantic tokens. Light and dark palettes use identical roles.

| Role | Light | Dark |
| --- | --- | --- |
| Canvas | `#ffffff` | `#131b1a` |
| Panel | `#ffffff` | `#192321` |
| Stone | `#eeece7` | `#27302b` |
| Text | `#212121` | `#eeeae2` |
| Divider | `#d9d9dd` | `#3b4c44` |
| Primary button | `#17171c` | `#eeece7` |
| Navigation | `#003c33` | `#0b2922` |
| Link | `#1863dc` | `#92baff` |
| Editorial accent | `#ff7759` | `#ff7759` |

Coral marks taxonomy and version labels. Pass, error and warning states use separate
green, red and amber roles and always retain textual verdicts. Never rely on color alone.
Use the brighter sidebar-specific text roles inside the dark navigation area.

## Typography

Display: Space Grotesk / Avenir Next / Segoe UI and Chinese system fallbacks.
Body: Inter and platform sans-serif fallbacks. Technical content: system monospace.
Fonts remain usable offline; proprietary Cohere fonts are not bundled.

- Overview title: 48px, regular weight, tight tracking; 36px on narrow screens.
- Page title: 32px; the authoring title is 24px and at most two lines, with the
  full title available in its tooltip, accessible text and configuration field.
- Section title: 18–24px; dense editor headings: 14–16px.
- Body and controls: 13–16px; metadata: 11–12px.
- Source editors retain monospace, line numbers and readable line spacing.

## Components

- Primary actions: near-black/light pill with contrasting text; 40px minimum height.
- Secondary actions: outlined pills; inline ancillary actions remain text buttons.
- Icon buttons: compact, with visible focus and accessible labels.
- Inputs: 8px corners and a thin border. Keyboard focus uses the blue focus role.
- Tabs: pill selections using the green accent surface; preserve keyboard navigation.
- Cards: 16px corners; major overview/login panels: 22px. Use flat surfaces and thin borders.
- Lists: rule-separated rows, real names and metadata, no unnecessary card nesting.
- Dialogs: existing native-dialog semantics, focus containment, Escape and backdrop behavior.
- Empty and error states: concise descriptions and the existing relevant actions.

## Page structure

The app frame keeps its sidebar, page toolbar, theme control, language switch and version.
The home overview uses real project/test/published counts and existing navigation links.
The editor keeps its configuration panel, authoring tabs, split preview and source editors.
Chat keeps conversation history, model controls, sources and composer alignment.
Records, contests, tasks and settings share the same surfaces and control hierarchy.

## Responsive behavior

- Desktop: 256px navigation; pages respond to available content width.
- Mobile navigation: existing modal drawer, with keyboard dismissal and focus restoration.
- Overview cards and forms stack when the content container becomes narrow.
- Mobile controls target 44px height; title and metadata wrap instead of clipping.
- Editor height ownership and short-screen natural flow remain intact. Program
  source cards keep a 300px minimum; the authoring panel scrolls when controls
  and source cannot fit together, instead of collapsing the source area.
- Wide code, tables and verification matrices scroll inside their own containers.
- Test 1440, 1024, 768, 390 and 320px, both themes and both interface languages.

## Boundaries

Do not introduce invented dashboard figures, nonfunctional controls, decorative gradients,
or heavy card shadows. Keep application styling separate from authored statements and
the PDF paper template. Preserve autosave, permissions, judging, export and task behavior.
Detailed acceptance records and screenshots stay outside the repository.
