---
name: Arama, filtre ve listeleme
description: Arama kutusu, öneriler, sonuç listesi, filtre, sıralama ve sayfalama.
triggers: ara, arama, arat, search, bul, sonuc, filtre, filtrele, sirala, siralama, kategori, listele, liste, sayfalama, oneri, autocomplete, otomatik tamamla
---
# Search, filters and lists

## Finding search
- A search box in the header, a magnifier icon (🔍) that expands a box, or a "Ara" tab on mobile. Write: "Arama kutusu görünmüyorsa büyüteç / Ara simgesine tıkla".

## Happy path
1. dismiss popups; 2. open search (conditional); 3. aiInput "Arama kutusu" ← query; 4. aiKeyboardPress Enter (or aiTap "Ara butonu" when the box has one and Enter does nothing); 5. aiWaitFor "Arama sonuçları yüklendi"; 6. aiAssert "Sonuç listesi görünüyor ve sonuçların en az biri '<query>' ile ilgili".
- Choose a query that surely exists on the site if the tester did not give one: a generic word from the site's own domain (e.g. a product type visible on the home page). Say which query you chose.

## Useful checks (pick by risk when "aramayı test et")
- No-result query (`zxqvw12345`) → a clear empty state ("sonuç bulunamadı"), no error page, no endless spinner.
- Autocomplete: typing 3 letters shows suggestions; choosing one opens relevant results.
- Case/diacritics: "KEDİ" vs "kedi", Turkish characters (ş, ğ, ı, İ) return comparable results.
- Leading/trailing spaces or special characters (`"`, `%`, `<`) do not break the page.
- Filter: apply one filter (e.g. a category/brand/price range) → results update and a visible filter chip/label shows it; clearing restores results.
- Sort: "Fiyat artan" → first items' prices ascending (assert visually on the first 3 items only).
- Pagination / infinite scroll: aiString name "ilkUrun" on the first item, aiScroll `scrollType: untilBottom` (or open the next page), then aiAssert new items appear and they are not only "{{saved.ilkUrun}}" repeated.
- Result count consistency: aiNumber name "sonucSayisi" from "… sonuç bulundu", apply a filter, aiAssert the shown count is smaller or equal.
- Back navigation from a result returns to the same result list/query.

## Midscene
- Arama kutusuna yazdıktan sonra öneri listesi açılırsa, talimat öneri seçmeyi istemiyorsa listeyi yok say.

## Assertion tips
- Assert relevance loosely ("ilgili", "içeriyor") and on the first few results only; never exact counts unless asked.
