export type OnboardingFirstReport = {
  slug: string;
  title: string;
  html: string;
};

export function buildOnboardingFirstReport(welcomeHtml: string): OnboardingFirstReport {
  return {
    slug: "welcome",
    title: "Welcome",
    html: welcomeHtml,
  };
}
