---
name: Mobil uygulama
description: Android ve iOS: izinler, tanıtım ekranları, sekme çubuğu, geri, klavye, soğuk açılış.
triggers: android, ios, iphone, ipad, mobil, uygulama, uygulamasi, uygulamada, app, telefon, tablet, cihaz, bildirim izni, izin, onboarding, tab bar, alt menu
---
# Mobile apps (Android / iOS)

- The runner cold-starts the app before the first step; there is no address bar. Every navigation happens through the app UI.
- **First steps** handle system and app interruptions: "İzin penceresi (bildirim, konum, kamera, takip) çıkarsa İzin ver / İzin verme / Şimdi değil ile kapat — test gerektirmiyorsa reddet" and "Tanıtım / onboarding ekranları görünüyorsa Atla / Geç / Başla ile geç".
- Navigation is usually a bottom tab bar (Ana sayfa, Ara, Profil/Hesap…) or a hamburger/side menu. Describe tabs by label and icon.
- Back: Android has the system back (`{"action":"back"}`); iOS has none — use the in-app back arrow ("Sol üstteki geri oku"). Never use `back` for web.
- Keyboards can cover buttons: after typing, "Klavye açıksa kapat" or scroll ("Sayfayı aşağı kaydırarak Devam butonunu göster") before tapping.
- Scrolling: `aiScroll` (direction down; `scrollType: untilBottom` for the end of a list; `locate` for a scrollable area such as a horizontal carousel with direction right). Use aiAct "… görünene kadar kaydır" only when the target must be recognised on the way.
- Long press: `aiLongPress` with the element (e.g. to open a context menu); pinch zoom on images/maps: `aiPinch` direction out/in.
- Pull-to-refresh and swipes: describe them as goals in `aiAct`.
- WebViews and in-app browsers exist; payment and social login often open external sheets — stop there (core safety rules).
- Device differences: small screens hide labels behind icons; prefer icon + label descriptions ("profil (kişi) simgesi").
- Keyboard: `aiKeyboardPress` Enter submits many mobile search fields; if not, tap the keyboard's search/return key via aiTap.
- The tester may name a device ("iPhone 15'te", "Pixel'de"): keep the platform of the chosen configuration; the runner narrows the device.

## Midscene
- İzin (bildirim, konum, kamera, takip) penceresi çıkarsa talimat istemedikçe "İzin verme / Şimdi değil" ile kapat.
- Tanıtım / onboarding ekranlarını "Atla / Geç / Başla" ile geç.
- Klavye bir butonu kapatıyorsa önce klavyeyi kapat veya sayfayı kaydır.
