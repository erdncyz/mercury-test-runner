---
name: Sepet, ödeme ve sipariş
description: Ürün detayı, sepet, adet, kupon, ödeme adımları ve sipariş; güvenli durma noktalarıyla.
triggers: sepet, sepete, cart, basket, odeme, checkout, satin al, satinal, siparis, order, kupon, indirim, promosyon, urun, kargo, adres, fatura, kredi karti, kart, abonelik, paket, satin
---
# Cart, checkout and orders

## Safety first
- Never place a real order or pay on `prod`/`production`/`canlı`/unknown environments: go to the last screen before "Siparişi onayla / Öde / Satın al", assert it shows the correct items and total, and stop. Say this in `reply`.
- Payment cards only if the tester provided documented test cards; never invent real-looking card numbers.
- Subscriptions/plans: do not confirm a purchase or cancellation unless the environment is test and the tester explicitly asked.

## Happy path: add to cart
1. dismiss popups; 2. aiAct "Stokta olan bir ürünü aç (liste/arama veya ana sayfadan ilk uygun ürün)"; 3. aiAct "Varsa zorunlu seçenekleri seç (beden, renk, adet)"; 4. aiTap "Sepete ekle butonu"; 5. aiWaitFor "Sepete eklendi bildirimi veya sepet sayacı güncellendi"; 6. aiAct "Sepete git"; 7. aiAssert "Sepette seçilen ürün adıyla görünüyor ve toplam tutar gösteriliyor".
- If the tester says "sepetim"/"siparişlerim" the flow needs login first (core skill).

## Midscene
- "Satın al", "Siparişi onayla", "Ödemeyi tamamla" gibi son onay butonlarına talimat açıkça istemedikçe basma.
- Sepet genelde sağ üstte sepet/çanta simgesidir; sayı rozeti eklenen ürün sayısını gösterir.

## Useful checks (pick by risk)
- Quantity +/− updates line total and cart total; quantity 0/removal shows empty-cart state.
- Remove item → "Sepetiniz boş" empty state and a way back to shopping.
- Invalid coupon code → clear error, total unchanged; valid coupon (only if provided) → discount line.
- Required option not selected → "Lütfen beden seçin" style warning, not added.
- Guest checkout vs login prompt: proceeding to checkout as guest asks for login or offers guest checkout.
- Cart persistence: reload the page → items still in the cart.
- Checkout validation: empty address/required fields → field errors; stop before payment confirmation.
- Price consistency: on product detail `aiNumber` name "fiyat" ("Ürünün satış fiyatı, para birimi olmadan"), then in the cart `aiNumber` expect "{{saved.fiyat}}" ("Sepetteki bu ürün satırının birim fiyatı"). This is a real oracle, better than "fiyat doğru görünüyor".
