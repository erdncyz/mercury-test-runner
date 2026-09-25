---
name: Video ve medya oynatma
description: Video/ses oynatıcı, canlı yayın, içerik sayfası, oynatma kontrolleri, altyazı ve reklam.
triggers: video, oynat, oynatma, izle, izleme, player, oynatici, yayin, canli, canli yayin, dizi, film, bolum, icerik, muzik, ses, podcast, altyazi, dublaj, reklam, fragman, trailer, stream
---
# Video and media playback

## Happy path ("bir içerik oynat")
1. dismiss popups; 2. (login first if content requires an account/subscription); 3. aiAct "Ana sayfadan veya arama ile oynatılabilir bir içerik (film/bölüm/video) aç"; 4. aiTap "Oynat / İzle / ▶ butonu"; 5. aiWaitFor "Video oynatılıyor: oynatıcı açıldı ve yükleme göstergesi kayboldu" (allow for pre-roll ads: "reklam varsa bitmesini bekle veya Reklamı geç'e bas"); 6. aiAssert "Oynatıcı açık, video görüntüsü var ve duraklat (❚❚) kontrolü görünüyor".

## Useful checks (pick by risk)
- Pause/resume: tap the player to show controls, pause → play icon appears; resume → pause icon again.
- Progress: `aiString` name "sure1" on the elapsed time, `sleep` 5000, then aiAssert "Geçen süre {{saved.sure1}} değerinden ileride" — proves playback really runs.
- Seek: tap forward 10 s / drag progress → elapsed time jumps.
- Subtitles/audio: open the settings/subtitle menu, choose another language → the selection is marked (and subtitles appear if the content has them).
- Full screen toggle and back out of full screen.
- Continue watching: close and reopen the same content → resume prompt/position (if the product has it).
- Entitlement: a guest or non-entitled user sees a login/subscription prompt instead of playback.
- Live content: the live badge/indicator is shown and playback starts.

## Midscene
- Oynatıcı kontrolleri görünmüyorsa önce videonun üzerine bir kez dokun/tıkla; kontroller birkaç saniye sonra yeniden gizlenir.
- Reklam oynuyorsa "Reklamı geç" görünene kadar bekle, sonra ona bas.

## Known limits
- Headless browsers and emulators may block DRM-protected playback (black video, "desteklenmiyor"). If the failure message suggests DRM/codec, classify it as environment, not product bug.
- Assert on controls/indicators, not on specific frames.
