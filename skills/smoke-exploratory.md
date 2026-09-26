---
name: Smoke, navigasyon ve keşif
description: Hızlı sağlık kontrolü, ana menüler, sayfa açılışları, bozuk durumlar ve keşif testi.
triggers: smoke, duman, genel kontrol, ayakta, calisiyor mu, acilisyor mu, aciliyor mu, sayfalar, sayfalari, menu, menuler, link, linkler, navigasyon, gezin, kesif, explore, exploratory, siteyi test, uygulamayi test, her yeri, butun sayfa, tum sayfa, footer, header, 404, kirik
---
# Smoke, navigation and exploratory testing

## Modes
- **Quick smoke** ("smoke koş", "site ayakta mı", "genel bir bak"): 2–4 short cases, each ≤ 6 steps:
  1. Home loads: main content, logo/header and primary navigation visible; no error page (404/500/"bir şeyler ters gitti"), no endless spinner, no blank page.
  2. Primary navigation: open the top 3–5 main menu items one by one (one `aiAct` + `aiAssert` pair each, returning via the logo/menu): each opens a page with real content that matches its label.
  3. Key entry points exist and respond: search opens, login entry opens the login form, cart/profile icon responds (do not complete flows).
  4. Footer: a couple of footer links (e.g. "Hakkımızda", "İletişim", "Yardım") open non-empty pages.
- **Exploratory / "siteyi test et"**: one case per high-value area visible on the home page (search, a listing → detail page, login entry, a primary form). Depth over breadth: fewer areas with real oracles beat many shallow clicks.
- **Saved regression**: if the tester says "regresyon" or names TestRail suites/cases, prefer `run_suite` over designing new cases.

## Per-page checklist (turn into asserts where relevant)
- Visual: nothing overlapping or cut off, images load (no broken-image icons), text readable.
- Functional: buttons/links react; the page reached matches the label clicked.
- States: loading ends; empty states are explained; errors are human-readable.
- Content: no placeholder text ("lorem ipsum", "TODO", "{{…}}", "undefined", "null", "NaN").
- Navigation: back returns to the previous page; the logo returns home.
- Footer is below the fold: `aiScroll` with `scrollType: scrollToBottom` before checking footer links.

## Assertion tips
- Phrase smoke asserts as absence of failure plus presence of content: "Sayfa hata mesajı veya boş ekran göstermiyor ve '<menü adı>' ile ilgili içerik görünüyor".
