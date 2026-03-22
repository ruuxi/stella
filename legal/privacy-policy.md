# Privacy Policy

**Stella — FromYou LLC**

*Last updated: March 22, 2026*

This Privacy Policy describes how FromYou LLC ("FromYou," "we," "us," or "our") handles information when you use Stella, including the desktop application, mobile companion app, backend services, and related websites or APIs (collectively, the "Service").

Stella is built on a **local-first, privacy-by-design** architecture. The Stella platform is completely free and open source. We designed the system so that your personal data stays on your device. FromYou operates the **Stella Provider**, a managed LLM inference service, as a separate paid offering — this is the only component where your data transits our servers. This policy explains exactly what we do and do not collect, and the limited circumstances where data reaches our infrastructure.

---

## 1. Our Core Principle: Your Data Stays on Your Device

Stella runs primarily on your local machine. Unlike most AI assistants:

- **Your conversations are not stored on our servers.** Chat history, prompts, AI responses, agent state, and tool outputs are stored locally on your device in a local database.
- **No account is required.** You can use Stella anonymously without providing any personal information.
- **The platform is open source.** You can inspect exactly how your data is handled.

---

## 2. Information We Do NOT Collect

Under normal operation, we do **not** collect or store:

- Your conversations, prompts, or AI responses
- Files on your computer or files created, modified, or deleted by Stella's AI agents
- Screenshots, screen captures, or on-screen content read by the agent
- Browser history, bookmarks, or browsing data (yours or the agent's)
- Websites visited, forms filled, or actions taken by Stella's browser-use capabilities
- Contents of your messages, notes, or calendar
- Shell commands executed by the agent or their output
- Voice recordings or transcripts
- Any data discovered during onboarding personalization
- Your locally stored API keys
- Any record of what the AI agent does on your computer

---

## 3. Information Stored Locally on Your Device

The following data is created and stored **entirely on your device** and is never transmitted to our servers:

| Data | Purpose |
|------|---------|
| Conversations and chat history | Your interactions with Stella |
| Agent state and event transcripts | Runtime operation of the AI agent system |
| Tool execution results | Output from shell commands, file operations, web searches, browser actions |
| Computer-use activity logs | Records of agent actions (browsing, file edits, commands) — stored only on your device |
| Discovery signals (browser bookmarks, apps, dev environment, etc.) | Optional onboarding personalization |
| Pseudonymized identity map | De-identification of personal names/contacts found during discovery |
| Voice transcripts | Records of voice interactions |
| LLM API keys (encrypted) | Your own provider credentials for BYOK use |
| Local preferences and settings | Theme, model preferences, configuration |
| Self-modification history (Git) | Tracking of AI-made UI changes for undo/revert |
| Installed mods and skills | Extensions you have installed |
| Device identity keypair | Cryptographic identity for your device |
| Local SQLite database | Persistent storage for all of the above |

You have full control over this data. You can delete it at any time by removing the Stella data directory from your device or using the in-app reset function.

---

## 4. Information That Passes Through Our Servers

In limited circumstances, data transits our backend infrastructure:

### 4.1 Stella Provider (Managed LLM Inference)

The Stella Provider is our managed LLM inference service — the only paid component of Stella. When you use the Stella Provider (i.e., you have not configured your own API keys), your prompts are routed through our backend to a third-party AI model provider. During this process:

- Your prompt and the AI response **pass through our servers in transit** to reach the upstream AI provider.
- We **do not persistently store** the content of your prompts or responses.
- We **do log usage metadata** for billing and rate-limiting purposes: timestamp, model used, token count, duration, success/failure status, and your owner ID (if signed in) or an anonymous device identifier.
- When using BYOK (your own API keys), requests go directly from your device to the AI provider and **do not pass through our servers at all**. In this case, the Stella platform is entirely free and we have zero visibility into your AI usage.

### 4.2 Offline Responder

When your desktop is offline and you interact with Stella via the mobile app or a connected channel (Slack, Discord, etc.):

- Your message is sent to our backend and processed by a minimal fallback AI agent.
- The interaction is **transient** — it is processed in memory and not persistently stored beyond what is needed to deliver the response and record usage metadata.

### 4.3 Connector Message Routing

If you connect Stella to third-party messaging platforms (Slack, Discord, Telegram, Google Chat, Microsoft Teams), we store:

- **Connection metadata**: Which external account is linked to which Stella account, conversation mapping identifiers.
- **Transient message events**: Inbound and outbound messages held temporarily for delivery, with a short time-to-live. These are automatically cleaned up.

We do **not** permanently store the text content of connector messages.

---

## 5. Computer Use and Agent Activity Data

Stella's AI agents can perform actions on your computer, including browsing the web, executing commands, reading and writing files, and interacting with applications. **All data related to these activities is processed and stored entirely on your local device.** Specifically:

- Websites the agent visits, forms it fills, and data it reads from web pages are processed locally and never sent to our servers.
- Files the agent creates, reads, modifies, or deletes remain on your local filesystem.
- Shell commands and their output are executed and stored locally.
- Screenshots and screen content captured by the agent stay on your device.
- The complete history of all agent actions is recorded in your local conversation log, which we cannot access.

The only exception is when the agent's actions require an LLM inference call (e.g., the agent needs to decide what to do next). In that case, the prompt sent to the AI model may contain context about the agent's current task, which passes through the Stella Provider as described in Section 4.1 — but is not stored. If you use BYOK, even this data never reaches our servers.

---

## 6. Information We Collect When You Create an Account

Account creation is **optional**. If you choose to sign in, we collect:

| Data | Purpose |
|------|---------|
| Email address | Authentication (magic link sign-in), account identification |
| Name (if provided) | Display purposes |
| Account creation timestamp | Account management |

We use [Better Auth](https://better-auth.com) for authentication, with magic-link email sign-in. We do not collect passwords.

---

## 7. Billing Information

If you subscribe to a paid Stella Provider plan, payment is processed by **Stripe**. We store:

| Data | Purpose |
|------|---------|
| Stripe customer ID | Linking your account to Stripe |
| Subscription status and plan | Determining your access level |
| Payment method brand and last 4 digits | Displaying payment info in settings |
| Billing period dates | Usage window tracking |
| Usage totals (in micro-cents) | Enforcing plan limits |

We do **not** store your full credit card number, CVV, or banking details. All payment processing is handled by Stripe under their [privacy policy](https://stripe.com/privacy).

---

## 8. Device Information

When your desktop registers with our backend (for mobile bridge or connector functionality), we store:

| Data | Purpose |
|------|---------|
| Device ID | Identifying your desktop for message routing |
| Device public key | Verifying device identity via cryptographic signatures |
| Online status | Determining whether to route to your device or the offline responder |
| Platform (Windows/macOS) | Display purposes |
| Mobile bridge base URLs | Allowing your phone to connect to your desktop |

---

## 9. Anonymous Device Usage

If you use Stella without an account, we track:

| Data | Purpose |
|------|---------|
| Anonymous device identifier | Rate limiting |
| Request count and timestamps | Enforcing fair-use limits |

This data is not linked to any personal identity.

---

## 10. Social Features

If you use Stella's social features (friend system, chat rooms, collaborative sessions), the following is stored on our backend:

| Data | Purpose |
|------|---------|
| Social profile (nickname, friend code) | Discoverability |
| Friend relationships | Social graph |
| Chat room membership and messages | Social communication |
| Collaborative session metadata and file operations | Shared workspace functionality |

Social features are opt-in and require a signed-in account.

---

## 11. Mod Store

If you publish a mod to the Stella Mod Store, we store the mod package, metadata (name, description, author), and release artifacts. Published mods are publicly visible to other Stella users.

---

## 12. Third-Party Services

Stella integrates with the following categories of third-party services. When your data reaches these services, it is subject to their respective privacy policies:

| Service | When Used | Their Policy |
|---------|-----------|--------------|
| **AI model providers** (Anthropic, OpenAI, Google, etc.) | When processing AI requests via Stella Provider or BYOK | Each provider's own policy |
| **Stripe** | When subscribing to a paid plan | [stripe.com/privacy](https://stripe.com/privacy) |
| **fal.ai** | When using media generation features | [fal.ai/privacy](https://fal.ai/privacy) |
| **Messaging platforms** (Slack, Discord, Telegram, etc.) | When using connector integrations | Each platform's own policy |
| **Convex** | Backend infrastructure | [convex.dev/privacy](https://www.convex.dev/privacy) |

When using BYOK (your own API keys), AI requests go directly from your device to the provider — our servers are not involved.

---

## 13. Data Retention

| Data Type | Retention |
|-----------|-----------|
| Local device data | Until you delete it — we have no access to it |
| Account information | Until you delete your account |
| Billing records | As required by law and for dispute resolution (typically 7 years for financial records) |
| Usage metadata | Rolling windows (5-hour, weekly, monthly); aggregates retained for billing reconciliation |
| Transient connector events | Automatically deleted after a short TTL (minutes to hours) |
| Anonymous device usage | Retained for rate-limiting purposes; periodically pruned |
| Social data | Until you delete your account or the relevant content |

---

## 14. Data Security

We implement reasonable security measures to protect data that does reach our infrastructure:

- **Encryption in transit**: All communication between your device and our backend uses TLS/HTTPS.
- **Secret encryption**: User-provided secrets stored on our backend (e.g., Slack bot tokens) are encrypted using AES-256-GCM with a versioned master key system.
- **Local encryption**: API keys stored on your device are encrypted locally.
- **Device identity**: Devices authenticate to the backend using Ed25519 cryptographic keypairs.
- **Rate limiting**: Multi-layer rate limiting protects against abuse.
- **Provider redaction**: AI responses are scrubbed of upstream provider details before being returned to you.

---

## 15. Your Rights and Choices

### 15.1 Access and Control
Because Stella stores data locally, you have direct access to and control over your data at all times. You can:

- View, export, or delete your local data by accessing Stella's data directory.
- Use the in-app reset function to clear all local data.
- Revoke connected integrations at any time.
- Delete your account, which removes your account information, billing profile, social data, and published mods from our backend.

### 15.2 Discovery Opt-Out
During onboarding, each discovery category is individually selectable. The most sensitive category (Messages & Notes) is **disabled by default** and requires explicit opt-in. You can skip discovery entirely.

### 15.3 Anonymous Use
You can use Stella's core features without creating an account or providing any personal information.

### 15.4 BYOK
You can provide your own AI provider API keys to avoid routing prompts through our infrastructure entirely.

---

## 16. Children's Privacy

Stella is not directed to children under 13 years of age. We do not knowingly collect personal information from children under 13. If you believe we have inadvertently collected such information, please contact us and we will promptly delete it.

---

## 17. International Users

Our backend infrastructure is hosted in the United States. If you access the Service from outside the United States, your information (to the extent it reaches our servers, as described in this policy) may be transferred to and processed in the United States. By using the Service, you consent to this transfer.

---

## 18. California Privacy Rights

If you are a California resident, you may have additional rights under the California Consumer Privacy Act (CCPA). Given Stella's local-first architecture, the personal information we hold on our servers is minimal (account email, billing data, device identifiers). You may exercise your rights to know, delete, or opt out by contacting us at the address below.

We do **not** sell your personal information. We do **not** use your data for targeted advertising.

---

## 19. European Privacy Rights

If you are in the European Economic Area (EEA) or United Kingdom, you may have rights under the GDPR including the right to access, rectify, erase, restrict processing, data portability, and objection. Given that the vast majority of your data is stored locally on your device and never reaches our servers, these rights primarily apply to account information and billing data. Contact us to exercise these rights.

**Legal basis for processing**: Where we do process personal data, we rely on: (a) contractual necessity (providing the Service); (b) legitimate interests (security, abuse prevention, service improvement); and (c) your consent (optional features like discovery and social).

---

## 20. Changes to This Policy

We may update this Privacy Policy from time to time. We will indicate the date of the most recent revision at the top of this page. For material changes, we will make reasonable efforts to notify you. Your continued use of the Service after changes constitutes acceptance of the updated policy.

---

## 21. Open Source Transparency

Stella's platform is open source. You can review exactly how data is handled by inspecting the source code. We believe this is the strongest form of privacy assurance — you don't have to take our word for it.

---

## 22. Contact Us

If you have questions about this Privacy Policy or wish to exercise any of your rights, contact us at:

**FromYou LLC**
131 Continental Drive, Suite 305
Newark, DE 19713

Email: [contact@fromyou.ai](mailto:contact@fromyou.ai)
