---
name: Giriş ve oturum
description: Web ve mobilde giriş, çıkış, oturum ve kimlik bilgisi kontrolleri.
triggers: login, giris, oturum, sign in, signin, log in, cikis, logout, sign out, hesabim, hesaba, uye girisi, sifre, parola, kimlik
---
# Login and session

## Finding the entry point (page not seen yet)
- Entry is usually top-right: "Giriş", "Giriş yap", "Üye girişi", "Oturum aç", "Hesabım", "Login", "Sign in", a person/avatar icon. On narrow layouts it is inside the hamburger menu (☰); on mobile apps often a "Profil/Hesap" bottom tab.
- It may open a modal, a new page, or a two-step flow (identifier → "Devam/İleri" → password). Write: "Giriş formu görünmüyorsa Giriş / Giriş yap / Oturum aç / Hesabım bağlantısını bul ve tıkla", then "Şifre alanı görünmüyorsa Devam / İleri butonuna bas" after typing the identifier.
- Identifier field may be "E-posta", "Kullanıcı adı", "E-posta veya telefon", "Cep telefonu". Use `{{account.email}}` by default, `{{account.phone}}` when the field clearly asks a phone number.

## Happy path (1 case for "login ol")
1. aiAct: dismiss cookie/notification popups.
2. aiAct: open the login form (conditional, as above).
3. aiInput: identifier field ← `{{account.email}}`.
4. aiInput: "Şifre / Parola alanı" ← `{{account.password}}`.
5. aiTap: "Giriş yap / Oturum aç / Login butonu" (not the social-login buttons).
6. aiWaitFor: the login form closes or the page changes.
7. aiAssert: "Kullanıcı giriş yapmış: hesap menüsü / profil simgesi / Çıkış bağlantısı veya hoş geldin mesajı görünüyor ve giriş formu artık görünmüyor".

## When the tester says "login'i test et" (pick 2–4 by risk)
- Valid credentials → logged in (above).
- Wrong password (only once per run, shared account!) → error message visible AND still on the login form, not logged in.
- Non-existent e-mail (`qa.yok.<digits>@example.com`) + any password → error visible, not logged in.
- Empty submit → required-field validation shown on the identifier and/or password fields.
- Invalid e-mail format ("qa@") → format validation shown.
- Password show/hide toggle (eye icon) switches masking, if present.
- Logout: log in, open the account menu, choose "Çıkış / Oturumu kapat", assert the login entry is visible again and account items are gone.
- Session persists: after login, reload the page / reopen the app (new step "Sayfayı yenile" via aiAct) → still logged in.

## Midscene
- Giriş için Google, Apple veya Facebook ile giriş butonlarını değil, e-posta/kullanıcı adı ve şifre formunu kullan.
- Giriş formu bir pencere (modal) olarak açılabilir; alanları o pencerenin içinde ara.
- Kimlik alanından sonra şifre alanı görünmüyorsa Devam / İleri butonuna bas.

## Don't
- Don't trigger lockouts, "şifremi unuttum" resets, or password changes on the shared test user.
- Don't use social login, OTP or CAPTCHA flows — stop at that screen, assert it, report it.
- Don't assert only the URL; assert what a user sees.
