---
name: Görsel, içerik ve erişilebilirlik
description: Görsel düzen, içerik kalitesi, responsive görünüm ve ekran görüntüsünden erişilebilirlik.
triggers: gorsel, gorunum, tasarim, arayuz, ui, layout, responsive, kayma, tasma, hizalama, resim, gorsel kirik, icerik kontrol, yazim, typo, metin, ceviri, dil, erisilebilirlik, accessibility, a11y, kontrast, okunabilir, karanlik mod, dark mode
---
# Visual, content and accessibility checks

The vision agent sees only pixels, so phrase every check as something visible on screen.

## Visual / layout
- No overlapping or clipped elements, no horizontal overflow, header/footer intact.
- Images and icons load (no empty boxes or broken-image icons).
- Buttons and links look clickable and are not hidden behind banners.
- Dark mode (if asked): text stays readable, no white-on-white or black-on-black areas.

## Content
- No placeholder or raw template text: "lorem ipsum", "TODO", "{{…}}", "undefined", "null", "NaN", "[object Object]".
- Texts are in the expected language; no mixed untranslated keys (e.g. "home.title").
- Turkish characters render correctly (ğ ü ş ö ç ı İ, no "?" or boxes).
- Prices, dates and numbers use a consistent local format.

## Accessibility (visual approximation — say it is not a full audit)
- Text contrast is sufficient to read; important text is not light grey on white.
- Form fields have visible labels or placeholders that explain them.
- Icon-only buttons have an understandable icon; error messages are not colour-only.
- Focus/selection is visible after choosing an element (only if asked).
- A full audit (screen reader, ARIA, keyboard traps) needs other tools: mention this in `reply` when the tester asks for "erişilebilirlik testi".

## Assertion tips
- Keep each assert about one area: "Ana sayfa üst bölümünde üst üste binen veya kesilmiş öğe yok ve tüm görseller yüklenmiş".
