# Terms of Service

**Stella — FromYou LLC**

*Last updated: March 22, 2026*

These Terms of Service ("Terms") govern your use of Stella, including the desktop application, mobile companion app, backend services, and any related websites or APIs (collectively, the "Service"), operated by FromYou LLC, a Delaware limited liability company ("FromYou," "we," "us," or "our").

By accessing or using the Service, you agree to be bound by these Terms. If you do not agree, do not use the Service.

---

## 1. Beta Status

Stella is currently in **beta**. The Service is provided on an "as-is" and "as-available" basis. Features, pricing, availability, and functionality may change, be limited, or be discontinued at any time without prior notice. We make no guarantees regarding uptime, reliability, or the continued availability of any particular feature during the beta period.

---

## 2. Eligibility

You must be at least 13 years of age to use the Service. If you are under 18, you represent that your parent or legal guardian has reviewed and agreed to these Terms on your behalf.

---

## 3. Accounts and Authentication

### 3.1 Anonymous Use

Stella can be used without creating an account. Anonymous users receive access to core functionality subject to rate limits.

### 3.2 Registered Accounts

You may optionally create an account using magic-link email authentication. If you create an account, you are responsible for maintaining the security of your login credentials and for all activity that occurs under your account.

### 3.3 Account Linking

If you upgrade from anonymous use to a registered account, any anonymous session data may be linked to your new account.

---

## 4. Description of the Service

### 4.1 The Stella Platform (Free)

Stella is a personal AI assistant that runs primarily on your local device. The platform is **completely free** and open source. It includes:

- **Desktop application** — An Electron-based application that runs AI agent orchestration, tool execution, computer use, and data storage locally on your computer.
- **Mobile companion app** — A lightweight mobile client that connects to your desktop or provides an offline fallback chat.
- **Open-source codebase** — Stella's platform is open source. You may inspect, modify, and contribute to the source code subject to the applicable open-source license(s) governing the repository.

### 4.2 The Stella Provider (Paid LLM Service)

Separately, FromYou operates the **Stella Provider**, a managed LLM inference service that routes AI model requests to upstream providers on your behalf. The Stella Provider is the paid component of the Service — subscription plans and usage-based billing apply to LLM inference consumed through the Stella Provider. You are never required to use the Stella Provider; you may supply your own API keys (BYOK) and use the platform entirely for free.

### 4.3 Additional Backend Services

Our backend also provides authentication, an offline fallback responder, connector integrations (Slack, Discord, Telegram, etc.), the mod store, social features, and media generation capabilities.

---

## 5. Local-First Architecture and Your Data

### 5.1 Local Storage

Stella is designed with a local-first architecture. Your conversations, chat history, agent state, event transcripts, tool outputs, and personal data are stored **locally on your device** — not on our servers. We do not have access to this data.

### 5.2 No Cloud Storage of Conversations

We do not store your conversation content, prompts, or AI responses on our cloud infrastructure under normal operation. The sole exception is the **offline responder** described in Section 5.3.

### 5.3 Offline Responder

When your desktop application is not running or not reachable, you may interact with Stella through the mobile app or connected channels (Slack, Discord, etc.). In this case, your message is sent to our backend, processed by a minimal fallback AI agent, and a response is returned. **These offline interactions are transient** — they are processed in memory and are not persistently stored in our systems beyond what is required to deliver the response and record usage for billing purposes.

### 5.4 Discovery Signals

During onboarding, Stella may optionally collect signals from your device (browser bookmarks, installed applications, development environment, etc.) to personalize your experience. This data is processed and stored **entirely on your local device**. Discovery categories involving sensitive data (messages, notes) are opt-in and disabled by default.

### 5.5 Connector Integrations

If you connect Stella to third-party platforms (Slack, Discord, Telegram, Google Chat, Microsoft Teams), inbound messages from those platforms are routed to your desktop device for local processing whenever possible. When your desktop is offline, the backend offline responder processes them transiently as described in Section 5.3. Connector routing metadata (connection identifiers, conversation mappings) is stored on our backend to facilitate message delivery.

---

## 6. Computer Use and Agent Autonomy

### 6.1 What Stella Can Do on Your Computer

Stella's AI agents can perform actions on your computer on your behalf, including but not limited to:

- Reading, writing, editing, and deleting files and directories.
- Executing shell commands and running scripts.
- Browsing the web, clicking links, filling forms, and navigating websites.
- Capturing screenshots and reading on-screen content.
- Opening applications and interacting with your operating system.
- Modifying Stella's own user interface and code.
- Scheduling automated tasks that run in the background.
- Interacting with connected services and APIs.

### 6.2 Your Responsibility

**You are solely and entirely responsible for all actions that Stella's AI agents perform on your computer and accounts.** Stella acts as a tool under your direction. When you instruct Stella to perform a task, you authorize it to take the actions necessary to complete that task, including any intermediate steps the AI determines are needed.

You acknowledge and agree that:

- AI agents may take actions that produce **unintended, incorrect, or irreversible results**, including data loss, file deletion, unintended purchases, unauthorized access to services, or system damage.
- It is **your responsibility** to review, supervise, and verify the actions taken by AI agents. You should not grant Stella access to systems or accounts where unintended actions could cause harm you are unwilling to accept.
- FromYou **does not control, review, or approve** the specific actions an AI agent takes in response to your instructions. The AI's behavior is determined by the underlying language model, your prompts, your system configuration, and the tools available.
- FromYou is **not liable** for any loss, damage, cost, or consequence resulting from actions performed by Stella's AI agents on your device, accounts, or connected services, regardless of whether those actions were intended, expected, or authorized by you.

### 6.3 Safety Mechanisms

Stella includes certain safety mechanisms (e.g., command safety checks, network guards, security policies, confirmation prompts for sensitive operations). These mechanisms are provided as a convenience and are **not guaranteed** to prevent all harmful actions. You should not rely on them as a substitute for your own judgment and supervision.

---

## 7. AI Services and the Stella Provider

### 7.1 Managed LLM Inference (Stella Provider)

The Stella Provider is a managed LLM inference service. When you do not supply your own API keys, Stella routes AI model requests through our backend to upstream AI model providers. We resolve the underlying model on the server side. Your prompts and responses pass through our infrastructure in transit but are **not stored** by us beyond what is necessary for real-time processing and usage metering.

The Stella Provider is the only paid component of the Service. Subscription plans provide access to higher usage limits and additional AI models.

### 7.2 Bring Your Own Keys (BYOK)

You may configure your own API keys for supported AI providers (Anthropic, OpenAI, Google, etc.). When using BYOK, requests are sent directly from your device to the provider, and our backend is not involved in those AI calls. Your API keys are stored locally on your device in encrypted form. **Using BYOK means you can use Stella entirely for free.**

### 7.3 Third-Party AI Providers

Whether using the Stella Provider or BYOK, your prompts and data are processed by third-party AI model providers. These providers have their own terms of service and privacy policies. We do not control how third-party providers handle your data once it reaches their systems. FromYou is not responsible for the outputs, accuracy, or behavior of any third-party AI model.

### 7.4 Media Generation

Stella may offer media generation features (image, audio, video) through third-party providers. Media generation requests are processed by those providers and subject to their terms.

---

## 8. Subscription Plans and Billing

### 8.1 Free Use

The Stella platform is **free to use**. You can use all features of the desktop and mobile application at no cost by providing your own API keys (BYOK).

### 8.2 Stella Provider Plans

The Stella Provider LLM inference service offers a free tier with rate-limited access, as well as paid subscription plans (currently Go, Pro, Plus, and Ultra) with higher usage limits and access to additional AI models. Paid plans are billed monthly through Stripe.

### 8.3 Pricing Changes

All prices are **subject to change** at any time, including during the beta period. We will make reasonable efforts to notify active subscribers of pricing changes in advance. Continued use of a paid plan after a price change constitutes acceptance of the new pricing.

### 8.4 Usage Limits

Each plan includes usage allowances measured in token consumption. If you exceed your plan's limits, service may be temporarily throttled until the next billing period.

### 8.5 Cancellation

You may cancel your subscription at any time. Cancellation takes effect at the end of the current billing period. No refunds are provided for partial billing periods.

---

## 9. Self-Modifying Capabilities

Stella's AI agents can modify the application's own user interface and functionality when instructed by you. These modifications are made locally via Vite hot-module replacement and are tracked in a local Git repository on your device. You may revert any self-modification at any time. **You are responsible for reviewing and accepting changes** made by the AI to your local Stella installation.

---

## 10. Mod Store

### 10.1 Publishing

You may publish modifications ("mods") to the Stella Mod Store. By publishing, you grant FromYou and other Stella users a non-exclusive, worldwide, royalty-free license to use, install, and distribute your mod through the Service.

### 10.2 Installing

Mods are community-created and are not reviewed or endorsed by FromYou. You install mods at your own risk. We are not responsible for any damage, data loss, or security issues caused by third-party mods.

### 10.3 Prohibited Content

You may not publish mods that contain malware, violate any law, infringe third-party rights, or are designed to harm users or their systems.

---

## 11. Open-Source Software

Stella's platform is open source. Your use of the open-source code is governed by the applicable open-source license(s) in the repository. These Terms govern your use of the hosted Service (backend APIs, Stella Provider, Mod Store, etc.) which may include components, infrastructure, and services not covered by the open-source license.

---

## 12. Acceptable Use

You agree not to:

- Use the Service for any unlawful purpose or to violate any applicable law or regulation.
- Attempt to gain unauthorized access to any part of the Service or its related systems.
- Interfere with or disrupt the Service, servers, or networks connected to the Service.
- Use the Service to generate content that is illegal, harmful, threatening, abusive, harassing, defamatory, or otherwise objectionable.
- Circumvent any rate limits, usage restrictions, or access controls.
- Reverse-engineer, decompile, or disassemble any proprietary component of the Service (this does not restrict your rights under the applicable open-source license for open-source components).
- Use the Service to build a competing product or service by systematically extracting data from our backend APIs.
- Resell access to the Stella Provider or backend services without our written permission.

---

## 13. Intellectual Property

### 13.1 Our Rights

The Stella name, logo, and branding are the property of FromYou LLC. The hosted backend services, API infrastructure, and any proprietary components not released under an open-source license remain the intellectual property of FromYou.

### 13.2 Your Rights

You retain all rights to your data, conversations, and any content you create using the Service. You retain all rights to mods you create, subject to the license granted in Section 10.1.

### 13.3 Open Source

Open-source components of Stella are licensed under their respective open-source licenses.

---

## 14. Disclaimer of Warranties

THE SERVICE IS PROVIDED "AS IS" AND "AS AVAILABLE" WITHOUT WARRANTIES OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, AND NON-INFRINGEMENT. FROMYOU DOES NOT WARRANT THAT THE SERVICE WILL BE UNINTERRUPTED, ERROR-FREE, OR SECURE. THE SERVICE IS IN BETA AND MAY CONTAIN BUGS, ERRORS, AND INCOMPLETE FEATURES.

AI-GENERATED CONTENT MAY BE INACCURATE, INCOMPLETE, OR INAPPROPRIATE. YOU ARE SOLELY RESPONSIBLE FOR EVALUATING AND USING AI-GENERATED OUTPUT. FROMYOU IS NOT LIABLE FOR ANY ACTIONS TAKEN BASED ON AI-GENERATED CONTENT OR ANY ACTIONS PERFORMED BY STELLA'S AI AGENTS ON YOUR COMPUTER, ACCOUNTS, OR CONNECTED SERVICES, INCLUDING BUT NOT LIMITED TO CODE EXECUTION, FILE CREATION OR DELETION, SHELL COMMANDS, WEB BROWSING, FORM SUBMISSIONS, PURCHASES, DATA TRANSMISSION, OR ANY OTHER OPERATION THE AGENT PERFORMS. YOU USE STELLA'S COMPUTER-USE CAPABILITIES ENTIRELY AT YOUR OWN RISK.

---

## 15. Limitation of Liability

TO THE MAXIMUM EXTENT PERMITTED BY LAW, FROMYOU SHALL NOT BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES, INCLUDING BUT NOT LIMITED TO LOSS OF DATA, LOSS OF PROFITS, DAMAGE TO YOUR DEVICE OR SYSTEMS, UNAUTHORIZED ACCESS TO YOUR ACCOUNTS, UNINTENDED PURCHASES OR TRANSACTIONS, OR ANY OTHER HARM ARISING FROM ACTIONS PERFORMED BY STELLA'S AI AGENTS, REGARDLESS OF THE THEORY OF LIABILITY.

WITHOUT LIMITING THE FOREGOING, FROMYOU SHALL NOT BE LIABLE FOR ANY DAMAGES ARISING FROM: (A) ACTIONS TAKEN BY AI AGENTS ON YOUR COMPUTER OR ACCOUNTS; (B) INACCURATE, INCOMPLETE, OR HARMFUL AI-GENERATED OUTPUT; (C) MODS OR EXTENSIONS CREATED BY THIRD PARTIES; (D) INTERRUPTIONS OR ERRORS IN THE STELLA PROVIDER INFERENCE SERVICE; OR (E) THE ACTS OR OMISSIONS OF THIRD-PARTY AI MODEL PROVIDERS.

OUR TOTAL AGGREGATE LIABILITY FOR ALL CLAIMS ARISING OUT OF OR RELATED TO THESE TERMS OR THE SERVICE SHALL NOT EXCEED THE GREATER OF (A) THE AMOUNT YOU PAID TO FROMYOU FOR THE STELLA PROVIDER IN THE TWELVE MONTHS PRECEDING THE CLAIM, OR (B) FIFTY DOLLARS ($50).

---

## 16. Indemnification

You agree to indemnify and hold harmless FromYou, its officers, directors, employees, and agents from any claims, liabilities, damages, losses, or expenses (including reasonable attorneys' fees) arising out of or related to: (a) your use of the Service, including any actions taken by AI agents on your behalf; (b) your violation of these Terms; (c) mods you publish to the Mod Store; (d) your violation of any third-party rights; or (e) any consequences of computer-use actions performed by Stella on your device, accounts, or connected services.

---

## 17. Third-Party Services

The Service integrates with third-party services including AI model providers, Stripe for payments, fal.ai for media generation, and messaging platforms. Your use of these services is subject to their respective terms. We are not responsible for the availability, accuracy, or practices of any third-party service.

---

## 18. Termination

We may suspend or terminate your access to the Service at any time, with or without cause, with or without notice. You may stop using the Service at any time. Upon termination, your right to use the hosted backend services ceases, but your locally stored data remains on your device under your control.

---

## 19. Governing Law and Dispute Resolution

These Terms are governed by the laws of the State of Delaware, without regard to its conflict-of-law provisions. Any dispute arising under these Terms shall be resolved in the state or federal courts located in Delaware, and you consent to personal jurisdiction in those courts.

---

## 20. Changes to These Terms

We may update these Terms from time to time. We will indicate the date of the most recent revision at the top of this page. Your continued use of the Service after any changes constitutes acceptance of the updated Terms. For material changes, we will make reasonable efforts to notify you (e.g., through the application or by email if you have an account).

---

## 21. Severability

If any provision of these Terms is found to be invalid or unenforceable, the remaining provisions shall continue in full force and effect.

---

## 22. Entire Agreement

These Terms, together with our [Privacy Policy](./privacy-policy.md), constitute the entire agreement between you and FromYou regarding the Service and supersede any prior agreements.

---

## 23. Contact Us

If you have questions about these Terms, contact us at:

**FromYou LLC**
131 Continental Drive, Suite 305
Newark, DE 19713

Email: [contact@fromyou.ai](mailto:contact@fromyou.ai)