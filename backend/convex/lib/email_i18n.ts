/**
 * Email-only translation strings. Kept separate from the desktop
 * renderer's i18n catalogs because the backend can't import from
 * `desktop/src/`. Mirrors the same supported-locale set so the user's
 * stored locale (BCP-47) maps to a copy bundle here.
 *
 * Keys are intentionally minimal — only what the email templates
 * actually render. New surfaces should add their own bundle next to
 * this one, not extend the magic-link strings.
 */

type EmailStrings = {
  signInTitle: string;
  signInDescription: string;
  signInButton: string;
  ignoreFooter: string;
  subjectMagicLink: string;
};

const STRINGS: Record<string, EmailStrings> = {
  en: {
    signInTitle: "Sign in",
    signInDescription:
      "Tap the link below to access your account. It expires in 10 minutes.",
    signInButton: "Sign in to Stella",
    ignoreFooter: "If you didn't request this email, you can safely ignore it.",
    subjectMagicLink: "Sign in to Stella",
  },
  es: {
    signInTitle: "Iniciar sesión",
    signInDescription:
      "Toca el enlace de abajo para acceder a tu cuenta. Caduca en 10 minutos.",
    signInButton: "Inicia sesión en Stella",
    ignoreFooter:
      "Si no solicitaste este correo, puedes ignorarlo sin problema.",
    subjectMagicLink: "Inicia sesión en Stella",
  },
  fr: {
    signInTitle: "Se connecter",
    signInDescription:
      "Appuyez sur le lien ci-dessous pour accéder à votre compte. Il expire dans 10 minutes.",
    signInButton: "Se connecter à Stella",
    ignoreFooter:
      "Si vous n'avez pas demandé cet e-mail, vous pouvez l'ignorer.",
    subjectMagicLink: "Se connecter à Stella",
  },
  de: {
    signInTitle: "Anmelden",
    signInDescription:
      "Tippe auf den Link unten, um auf dein Konto zuzugreifen. Er läuft in 10 Minuten ab.",
    signInButton: "Bei Stella anmelden",
    ignoreFooter:
      "Wenn du diese E-Mail nicht angefordert hast, kannst du sie einfach ignorieren.",
    subjectMagicLink: "Bei Stella anmelden",
  },
  it: {
    signInTitle: "Accedi",
    signInDescription:
      "Tocca il link qui sotto per accedere al tuo account. Scade tra 10 minuti.",
    signInButton: "Accedi a Stella",
    ignoreFooter:
      "Se non hai richiesto questa email, puoi tranquillamente ignorarla.",
    subjectMagicLink: "Accedi a Stella",
  },
  pt: {
    signInTitle: "Entrar",
    signInDescription:
      "Toque no link abaixo para acessar a sua conta. Expira em 10 minutos.",
    signInButton: "Entrar na Stella",
    ignoreFooter:
      "Se você não solicitou este e-mail, pode ignorá-lo com segurança.",
    subjectMagicLink: "Entrar na Stella",
  },
  nl: {
    signInTitle: "Inloggen",
    signInDescription:
      "Tik op de onderstaande link om bij je account te komen. Deze verloopt in 10 minuten.",
    signInButton: "Inloggen bij Stella",
    ignoreFooter:
      "Als je deze e-mail niet hebt aangevraagd, kun je hem gerust negeren.",
    subjectMagicLink: "Inloggen bij Stella",
  },
  ru: {
    signInTitle: "Вход",
    signInDescription:
      "Нажмите на ссылку ниже, чтобы войти в аккаунт. Срок действия — 10 минут.",
    signInButton: "Войти в Stella",
    ignoreFooter:
      "Если вы не запрашивали это письмо, его можно просто проигнорировать.",
    subjectMagicLink: "Войти в Stella",
  },
  ja: {
    signInTitle: "サインイン",
    signInDescription:
      "下のリンクをタップしてアカウントにアクセスします。10 分で有効期限が切れます。",
    signInButton: "Stella にサインイン",
    ignoreFooter:
      "このメールをリクエストしていない場合は、無視していただいて大丈夫です。",
    subjectMagicLink: "Stella にサインイン",
  },
  "zh-Hans": {
    signInTitle: "登录",
    signInDescription: "点击下方链接登录您的账户。链接将在 10 分钟后失效。",
    signInButton: "登录 Stella",
    ignoreFooter: "如果不是您请求的此邮件，可直接忽略。",
    subjectMagicLink: "登录 Stella",
  },
  "zh-Hant": {
    signInTitle: "登入",
    signInDescription: "點擊下方連結登入您的帳戶。連結將在 10 分鐘後失效。",
    signInButton: "登入 Stella",
    ignoreFooter: "如果不是您要求的此郵件，可直接忽略。",
    subjectMagicLink: "登入 Stella",
  },
  ko: {
    signInTitle: "로그인",
    signInDescription:
      "아래 링크를 눌러 계정에 접속하세요. 링크는 10분 뒤에 만료됩니다.",
    signInButton: "Stella에 로그인",
    ignoreFooter: "이 이메일을 요청하지 않았다면 무시하셔도 됩니다.",
    subjectMagicLink: "Stella에 로그인",
  },
  pl: {
    signInTitle: "Zaloguj się",
    signInDescription:
      "Kliknij poniższy link, aby uzyskać dostęp do konta. Wygaśnie za 10 minut.",
    signInButton: "Zaloguj się do Stelli",
    ignoreFooter:
      "Jeśli nie prosiłeś o tę wiadomość, możesz ją zignorować.",
    subjectMagicLink: "Zaloguj się do Stelli",
  },
  sv: {
    signInTitle: "Logga in",
    signInDescription:
      "Tryck på länken nedan för att komma åt ditt konto. Den går ut om 10 minuter.",
    signInButton: "Logga in på Stella",
    ignoreFooter:
      "Om du inte begärde det här e-postmeddelandet kan du strunta i det.",
    subjectMagicLink: "Logga in på Stella",
  },
  nb: {
    signInTitle: "Logg inn",
    signInDescription:
      "Trykk på lenken nedenfor for å få tilgang til kontoen din. Den utløper om 10 minutter.",
    signInButton: "Logg inn på Stella",
    ignoreFooter:
      "Hvis du ikke ba om denne e-posten, kan du trygt se bort fra den.",
    subjectMagicLink: "Logg inn på Stella",
  },
  da: {
    signInTitle: "Log ind",
    signInDescription:
      "Tryk på linket nedenfor for at få adgang til din konto. Det udløber om 10 minutter.",
    signInButton: "Log ind på Stella",
    ignoreFooter:
      "Hvis du ikke bad om denne e-mail, kan du roligt ignorere den.",
    subjectMagicLink: "Log ind på Stella",
  },
  fi: {
    signInTitle: "Kirjaudu sisään",
    signInDescription:
      "Napauta alla olevaa linkkiä päästäksesi tilillesi. Linkki vanhenee 10 minuutin kuluttua.",
    signInButton: "Kirjaudu Stellaan",
    ignoreFooter:
      "Jos et pyytänyt tätä viestiä, voit jättää sen huomiotta.",
    subjectMagicLink: "Kirjaudu Stellaan",
  },
  cs: {
    signInTitle: "Přihlásit se",
    signInDescription:
      "Klepnutím na odkaz níže získáte přístup ke svému účtu. Vyprší za 10 minut.",
    signInButton: "Přihlásit se do Stelly",
    ignoreFooter:
      "Pokud jste o tento e-mail nepožádali, můžete ho ignorovat.",
    subjectMagicLink: "Přihlásit se do Stelly",
  },
  el: {
    signInTitle: "Σύνδεση",
    signInDescription:
      "Πατήστε τον σύνδεσμο παρακάτω για να συνδεθείτε στον λογαριασμό σας. Λήγει σε 10 λεπτά.",
    signInButton: "Σύνδεση στη Stella",
    ignoreFooter:
      "Αν δεν ζητήσατε αυτό το email, μπορείτε να το αγνοήσετε.",
    subjectMagicLink: "Σύνδεση στη Stella",
  },
  tr: {
    signInTitle: "Giriş yap",
    signInDescription:
      "Hesabınıza erişmek için aşağıdaki bağlantıya dokunun. 10 dakika içinde geçerliliğini yitirir.",
    signInButton: "Stella'ya giriş yap",
    ignoreFooter:
      "Bu e-postayı siz talep etmediyseniz, görmezden gelebilirsiniz.",
    subjectMagicLink: "Stella'ya giriş yap",
  },
  ro: {
    signInTitle: "Conectează-te",
    signInDescription:
      "Apasă linkul de mai jos pentru a-ți accesa contul. Expiră în 10 minute.",
    signInButton: "Conectează-te la Stella",
    ignoreFooter:
      "Dacă nu ai solicitat acest e-mail, îl poți ignora în siguranță.",
    subjectMagicLink: "Conectează-te la Stella",
  },
  hu: {
    signInTitle: "Bejelentkezés",
    signInDescription:
      "Koppints az alábbi linkre a fiókod eléréséhez. 10 perc múlva lejár.",
    signInButton: "Belépés a Stellába",
    ignoreFooter:
      "Ha nem te kérted ezt az e-mailt, nyugodtan figyelmen kívül hagyhatod.",
    subjectMagicLink: "Belépés a Stellába",
  },
  ar: {
    signInTitle: "تسجيل الدخول",
    signInDescription:
      "اضغط على الرابط أدناه للوصول إلى حسابك. ينتهي خلال 10 دقائق.",
    signInButton: "تسجيل الدخول إلى Stella",
    ignoreFooter: "إذا لم تطلب هذا البريد، يمكنك تجاهله بأمان.",
    subjectMagicLink: "تسجيل الدخول إلى Stella",
  },
  hi: {
    signInTitle: "साइन इन",
    signInDescription:
      "अपने खाते में जाने के लिए नीचे दिए गए लिंक पर टैप करें। यह 10 मिनट में समाप्त हो जाएगा।",
    signInButton: "Stella में साइन इन करें",
    ignoreFooter:
      "अगर आपने यह ईमेल नहीं माँगा है, तो आप इसे अनदेखा कर सकते हैं।",
    subjectMagicLink: "Stella में साइन इन करें",
  },
  id: {
    signInTitle: "Masuk",
    signInDescription:
      "Ketuk tautan di bawah untuk mengakses akun Anda. Tautan ini kedaluwarsa dalam 10 menit.",
    signInButton: "Masuk ke Stella",
    ignoreFooter:
      "Jika Anda tidak meminta email ini, Anda dapat mengabaikannya.",
    subjectMagicLink: "Masuk ke Stella",
  },
  vi: {
    signInTitle: "Đăng nhập",
    signInDescription:
      "Nhấn vào liên kết bên dưới để truy cập tài khoản của bạn. Liên kết hết hạn sau 10 phút.",
    signInButton: "Đăng nhập vào Stella",
    ignoreFooter:
      "Nếu bạn không yêu cầu email này, bạn có thể bỏ qua nó.",
    subjectMagicLink: "Đăng nhập vào Stella",
  },
  th: {
    signInTitle: "เข้าสู่ระบบ",
    signInDescription:
      "แตะลิงก์ด้านล่างเพื่อเข้าสู่บัญชีของคุณ ลิงก์จะหมดอายุภายใน 10 นาที",
    signInButton: "เข้าสู่ระบบ Stella",
    ignoreFooter: "หากคุณไม่ได้ขออีเมลฉบับนี้ คุณสามารถมองข้ามได้เลย",
    subjectMagicLink: "เข้าสู่ระบบ Stella",
  },
  he: {
    signInTitle: "התחברות",
    signInDescription:
      "הקישו על הקישור למטה כדי להיכנס לחשבון. תוקף הקישור פג תוך 10 דקות.",
    signInButton: "התחברו ל-Stella",
    ignoreFooter:
      "אם לא ביקשתם את המייל הזה, אפשר להתעלם ממנו.",
    subjectMagicLink: "התחברו ל-Stella",
  },
};

export const getEmailStrings = (
  locale: string | null | undefined,
): EmailStrings => {
  if (!locale) return STRINGS.en;
  const trimmed = locale.trim();
  if (!trimmed) return STRINGS.en;
  if (STRINGS[trimmed]) return STRINGS[trimmed];
  // Match `pt-BR` → `pt`, `zh-CN` → `zh-Hans`, etc.
  if (trimmed.toLowerCase().startsWith("zh")) {
    return STRINGS["zh-Hans"];
  }
  const primary = trimmed.split(/[-_]/)[0];
  if (primary && STRINGS[primary]) return STRINGS[primary];
  return STRINGS.en;
};

/**
 * RTL-aware HTML lang/dir attributes for the email's `<html>` tag.
 * The body still inherits the document direction via parent attributes.
 */
export const emailDir = (locale: string | null | undefined): "ltr" | "rtl" =>
  locale === "ar" || locale === "he" ? "rtl" : "ltr";
