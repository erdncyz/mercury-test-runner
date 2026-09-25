---
name: Formlar ve doğrulama
description: İletişim, profil, adres, ayarlar gibi her veri giriş formu; doğrulama ve sınır değer kontrolleri.
triggers: form, formu, alan, alani, doldur, gonder, kaydet, validasyon, validation, dogrulama mesaji, zorunlu, iletisim, bize ulasin, basvuru, profil, profilimi, bilgilerimi, adres ekle, ayarlar, tercihler, guncelle, duzenle
---
# Forms and validation

## Happy path
- Fill every required field with realistic, clearly-fake data (unique digits where uniqueness matters), submit with the primary button, aiWaitFor the response, then assert the success signal ("Mesajınız gönderildi", "Bilgileriniz güncellendi", the new value visible after reload).
- For profile/settings on the shared test user: change only harmless fields (display name, a preference), and add a final step that restores the original value when the change could affect other runs. Never change e-mail, phone, password or 2FA of the shared user.

- Editing a pre-filled field: `aiClearInput` the field first, then `aiInput` the new value; after save, reload and `aiString` expect the new value.

## Validation checks (pick by risk)
- Empty submit → each required field shows its own message; nothing is saved/sent.
- Format: e-mail without "@", phone with letters, date in the future/past where not allowed, postal code length.
- Boundaries: max length (type 1 more than a reasonable limit, e.g. 256 chars) is blocked or clearly reported; min length for passwords/names.
- Whitespace-only input is not accepted as valid.
- Special characters and Turkish letters (ğüşöçıİ) are accepted where names/addresses are expected and displayed back correctly.
- Double submit: pressing the submit button twice quickly does not create two records/messages (assert a single confirmation).
- Error recovery: after a validation error, correcting the field and submitting succeeds.
- Unsaved changes: navigating away from a dirty form warns or discards as designed (only if the tester asks).

## Assertion tips
- Assert the message **near the field** ("E-posta alanının altında geçersiz e-posta uyarısı görünüyor") and that no success message appeared.
