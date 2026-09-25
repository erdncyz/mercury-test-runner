---
name: Kayıt ve şifre sıfırlama
description: Üye olma, kayıt formları, doğrulama ekranları ve şifremi unuttum akışı.
triggers: kayit, kaydol, uye ol, uyelik, register, sign up, signup, hesap olustur, yeni hesap, sifremi unuttum, sifre sifirla, sifre yenile, forgot, reset password, dogrulama kodu, aktivasyon
---
# Registration and password reset

## Sign-up
- Entry: "Üye ol", "Kayıt ol", "Hesap oluştur", "Sign up", often next to the login entry or at the bottom of the login form ("Hesabın yok mu? Kayıt ol").
- Always generate **new unique data** in the step values (random digits): e-mail `qa.kayit.<5 digits>@example.com`, name "Test Kullanıcı <digits>", phone in the local test format. Never use `{{account.email}}` for a new sign-up — that user already exists.
- Typical required parts: name, e-mail/phone, password (+ repeat), terms/KVKK/privacy checkboxes, sometimes birth date/gender. Tick only mandatory consents; leave marketing consents unticked unless asked.
- Oracle: success page / "Hesabınız oluşturuldu" / logged-in state / "doğrulama e-postası gönderildi" message. You cannot read e-mail or SMS: stop at the verification screen and assert it.
- High-value negatives (pick by risk):
  - Already registered e-mail (`{{account.email}}` when a test user exists) → "zaten kayıtlı" error.
  - Password rule boundaries: too short / missing required character class → rule message shown, account not created.
  - Password and repeat differ → mismatch message.
  - Terms checkbox unticked → cannot submit / warning.
  - Invalid e-mail format → validation.
- Production/unknown environment: fill and validate but do not submit a real account unless the tester explicitly asks.

## Forgot password
- Entry: "Şifremi unuttum", "Parolamı unuttum", "Forgot password" link on the login form.
- Use a non-existent or tester-given address, **never the shared test user** (a reset would break other runs), unless the tester explicitly asks.
- Oracle: confirmation message such as "Şifre sıfırlama bağlantısı gönderildi" (many sites show the same message for unknown e-mails — that is correct behaviour, not a bug).
- Negatives: empty submit → validation; invalid format → validation.
