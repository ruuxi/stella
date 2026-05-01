/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as account_deletion from "../account_deletion.js";
import type * as agent_agents from "../agent/agents.js";
import type * as agent_context_budget from "../agent/context_budget.js";
import type * as agent_device_resolver from "../agent/device_resolver.js";
import type * as agent_hooks from "../agent/hooks.js";
import type * as agent_invoke from "../agent/invoke.js";
import type * as agent_local_runtime from "../agent/local_runtime.js";
import type * as agent_model from "../agent/model.js";
import type * as agent_model_execution from "../agent/model_execution.js";
import type * as agent_model_failover from "../agent/model_failover.js";
import type * as agent_model_resolver from "../agent/model_resolver.js";
import type * as agent_prompt_builder from "../agent/prompt_builder.js";
import type * as agent_task_summaries from "../agent/task_summaries.js";
import type * as agent_tool_schemas from "../agent/tool_schemas.js";
import type * as ai_proxy_data from "../ai_proxy_data.js";
import type * as anon_cleanup from "../anon_cleanup.js";
import type * as auth from "../auth.js";
import type * as auth_migration from "../auth_migration.js";
import type * as automation_index from "../automation/index.js";
import type * as automation_runner from "../automation/runner.js";
import type * as backups from "../backups.js";
import type * as billing from "../billing.js";
import type * as channels_connector_auth from "../channels/connector_auth.js";
import type * as channels_connector_constants from "../channels/connector_constants.js";
import type * as channels_connector_delivery from "../channels/connector_delivery.js";
import type * as channels_discord from "../channels/discord.js";
import type * as channels_execution_policy from "../channels/execution_policy.js";
import type * as channels_google_chat from "../channels/google_chat.js";
import type * as channels_link_codes from "../channels/link_codes.js";
import type * as channels_linq from "../channels/linq.js";
import type * as channels_message_pipeline from "../channels/message_pipeline.js";
import type * as channels_routing_flow from "../channels/routing_flow.js";
import type * as channels_slack from "../channels/slack.js";
import type * as channels_slack_installations from "../channels/slack_installations.js";
import type * as channels_teams from "../channels/teams.js";
import type * as channels_telegram from "../channels/telegram.js";
import type * as channels_transient_data from "../channels/transient_data.js";
import type * as channels_utils from "../channels/utils.js";
import type * as cloudflare_tunnels from "../cloudflare_tunnels.js";
import type * as conversations from "../conversations.js";
import type * as crons from "../crons.js";
import type * as data_attachments from "../data/attachments.js";
import type * as data_desktop_releases from "../data/desktop_releases.js";
import type * as data_fashion from "../data/fashion.js";
import type * as data_integrations from "../data/integrations.js";
import type * as data_preferences from "../data/preferences.js";
import type * as data_secrets from "../data/secrets.js";
import type * as data_secrets_crypto from "../data/secrets_crypto.js";
import type * as data_secrets_rotation from "../data/secrets_rotation.js";
import type * as data_store_packages from "../data/store_packages.js";
import type * as data_thread_compaction_format from "../data/thread_compaction_format.js";
import type * as data_threads from "../data/threads.js";
import type * as data_user_profiles from "../data/user_profiles.js";
import type * as events from "../events.js";
import type * as feedback from "../feedback.js";
import type * as http from "../http.js";
import type * as http_routes_backups from "../http_routes/backups.js";
import type * as http_routes_connectors from "../http_routes/connectors.js";
import type * as http_routes_desktop_releases from "../http_routes/desktop_releases.js";
import type * as http_routes_dictation from "../http_routes/dictation.js";
import type * as http_routes_media from "../http_routes/media.js";
import type * as http_routes_mobile from "../http_routes/mobile.js";
import type * as http_routes_music from "../http_routes/music.js";
import type * as http_routes_stripe from "../http_routes/stripe.js";
import type * as http_routes_synthesis from "../http_routes/synthesis.js";
import type * as http_routes_voice from "../http_routes/voice.js";
import type * as http_shared_anon_device from "../http_shared/anon_device.js";
import type * as http_shared_cors from "../http_shared/cors.js";
import type * as http_shared_request from "../http_shared/request.js";
import type * as http_shared_sse from "../http_shared/sse.js";
import type * as http_shared_webhook_controls from "../http_shared/webhook_controls.js";
import type * as lib_agent_constants from "../lib/agent_constants.js";
import type * as lib_app_review_auth from "../lib/app_review_auth.js";
import type * as lib_async from "../lib/async.js";
import type * as lib_billing_date from "../lib/billing_date.js";
import type * as lib_billing_money from "../lib/billing_money.js";
import type * as lib_billing_plans from "../lib/billing_plans.js";
import type * as lib_coerce from "../lib/coerce.js";
import type * as lib_context_window from "../lib/context_window.js";
import type * as lib_crypto_utils from "../lib/crypto_utils.js";
import type * as lib_email_i18n from "../lib/email_i18n.js";
import type * as lib_email_templates from "../lib/email_templates.js";
import type * as lib_error_classification from "../lib/error_classification.js";
import type * as lib_http_utils from "../lib/http_utils.js";
import type * as lib_json from "../lib/json.js";
import type * as lib_managed_billing from "../lib/managed_billing.js";
import type * as lib_managed_gateway from "../lib/managed_gateway.js";
import type * as lib_managed_usage from "../lib/managed_usage.js";
import type * as lib_models_dev from "../lib/models_dev.js";
import type * as lib_number_utils from "../lib/number_utils.js";
import type * as lib_object_utils from "../lib/object_utils.js";
import type * as lib_owner_ids from "../lib/owner_ids.js";
import type * as lib_provider_keys from "../lib/provider_keys.js";
import type * as lib_provider_redaction from "../lib/provider_redaction.js";
import type * as lib_providers from "../lib/providers.js";
import type * as lib_rate_limits from "../lib/rate_limits.js";
import type * as lib_redaction from "../lib/redaction.js";
import type * as lib_retry_fetch from "../lib/retry_fetch.js";
import type * as lib_shopify_ucp from "../lib/shopify_ucp.js";
import type * as lib_store_artifacts from "../lib/store_artifacts.js";
import type * as lib_store_icon from "../lib/store_icon.js";
import type * as lib_store_release_reviews from "../lib/store_release_reviews.js";
import type * as lib_text_utils from "../lib/text_utils.js";
import type * as lib_thread_compaction from "../lib/thread_compaction.js";
import type * as lib_tool_call_utils from "../lib/tool_call_utils.js";
import type * as lib_url_security from "../lib/url_security.js";
import type * as lib_validator from "../lib/validator.js";
import type * as lib_welcome_suggestions_parse from "../lib/welcome_suggestions_parse.js";
import type * as media_billing from "../media_billing.js";
import type * as media_catalog from "../media_catalog.js";
import type * as media_contract from "../media_contract.js";
import type * as media_fal_webhooks from "../media_fal_webhooks.js";
import type * as media_jobs from "../media_jobs.js";
import type * as mobile_access from "../mobile_access.js";
import type * as mobile_auth from "../mobile_auth.js";
import type * as mobile_bridge from "../mobile_bridge.js";
import type * as prompts_discovery_facts from "../prompts/discovery_facts.js";
import type * as prompts_execution from "../prompts/execution.js";
import type * as prompts_index from "../prompts/index.js";
import type * as prompts_invoke from "../prompts/invoke.js";
import type * as prompts_offline_responder from "../prompts/offline_responder.js";
import type * as prompts_registry from "../prompts/registry.js";
import type * as prompts_store_reviews from "../prompts/store_reviews.js";
import type * as prompts_synthesis from "../prompts/synthesis.js";
import type * as prompts_system_assembly from "../prompts/system_assembly.js";
import type * as prompts_thread_compaction from "../prompts/thread_compaction.js";
import type * as prompts_voice_orchestrator from "../prompts/voice_orchestrator.js";
import type * as r2_files from "../r2_files.js";
import type * as rate_limits from "../rate_limits.js";
import type * as reset from "../reset.js";
import type * as runtime_ai_anthropic from "../runtime_ai/anthropic.js";
import type * as runtime_ai_event_stream from "../runtime_ai/event_stream.js";
import type * as runtime_ai_google from "../runtime_ai/google.js";
import type * as runtime_ai_json_parse from "../runtime_ai/json_parse.js";
import type * as runtime_ai_managed from "../runtime_ai/managed.js";
import type * as runtime_ai_model_utils from "../runtime_ai/model_utils.js";
import type * as runtime_ai_openai_completions from "../runtime_ai/openai_completions.js";
import type * as runtime_ai_openai_responses from "../runtime_ai/openai_responses.js";
import type * as runtime_ai_openai_responses_shared from "../runtime_ai/openai_responses_shared.js";
import type * as runtime_ai_sanitize_unicode from "../runtime_ai/sanitize_unicode.js";
import type * as runtime_ai_simple_options from "../runtime_ai/simple_options.js";
import type * as runtime_ai_stream from "../runtime_ai/stream.js";
import type * as runtime_ai_transform_messages from "../runtime_ai/transform_messages.js";
import type * as runtime_ai_types from "../runtime_ai/types.js";
import type * as runtime_ai_usage from "../runtime_ai/usage.js";
import type * as scheduling_cron_jobs from "../scheduling/cron_jobs.js";
import type * as scheduling_desktop_handoff_policy from "../scheduling/desktop_handoff_policy.js";
import type * as schema_agents from "../schema/agents.js";
import type * as schema_auth from "../schema/auth.js";
import type * as schema_backups from "../schema/backups.js";
import type * as schema_billing from "../schema/billing.js";
import type * as schema_conversations from "../schema/conversations.js";
import type * as schema_desktop_releases from "../schema/desktop_releases.js";
import type * as schema_devices from "../schema/devices.js";
import type * as schema_fashion from "../schema/fashion.js";
import type * as schema_feedback from "../schema/feedback.js";
import type * as schema_integrations from "../schema/integrations.js";
import type * as schema_media from "../schema/media.js";
import type * as schema_scheduling from "../schema/scheduling.js";
import type * as schema_social from "../schema/social.js";
import type * as schema_store from "../schema/store.js";
import type * as schema_telemetry from "../schema/telemetry.js";
import type * as schema_users from "../schema/users.js";
import type * as shared_validators from "../shared_validators.js";
import type * as social_censor from "../social/censor.js";
import type * as social_messages from "../social/messages.js";
import type * as social_profiles from "../social/profiles.js";
import type * as social_relationships from "../social/relationships.js";
import type * as social_rooms from "../social/rooms.js";
import type * as social_sessions from "../social/sessions.js";
import type * as social_shared from "../social/shared.js";
import type * as stella_models from "../stella_models.js";
import type * as stella_provider from "../stella_provider.js";
import type * as tools_backend from "../tools/backend.js";
import type * as tools_index from "../tools/index.js";
import type * as tools_types from "../tools/types.js";
import type * as tools_voice_schemas from "../tools/voice_schemas.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  account_deletion: typeof account_deletion;
  "agent/agents": typeof agent_agents;
  "agent/context_budget": typeof agent_context_budget;
  "agent/device_resolver": typeof agent_device_resolver;
  "agent/hooks": typeof agent_hooks;
  "agent/invoke": typeof agent_invoke;
  "agent/local_runtime": typeof agent_local_runtime;
  "agent/model": typeof agent_model;
  "agent/model_execution": typeof agent_model_execution;
  "agent/model_failover": typeof agent_model_failover;
  "agent/model_resolver": typeof agent_model_resolver;
  "agent/prompt_builder": typeof agent_prompt_builder;
  "agent/task_summaries": typeof agent_task_summaries;
  "agent/tool_schemas": typeof agent_tool_schemas;
  ai_proxy_data: typeof ai_proxy_data;
  anon_cleanup: typeof anon_cleanup;
  auth: typeof auth;
  auth_migration: typeof auth_migration;
  "automation/index": typeof automation_index;
  "automation/runner": typeof automation_runner;
  backups: typeof backups;
  billing: typeof billing;
  "channels/connector_auth": typeof channels_connector_auth;
  "channels/connector_constants": typeof channels_connector_constants;
  "channels/connector_delivery": typeof channels_connector_delivery;
  "channels/discord": typeof channels_discord;
  "channels/execution_policy": typeof channels_execution_policy;
  "channels/google_chat": typeof channels_google_chat;
  "channels/link_codes": typeof channels_link_codes;
  "channels/linq": typeof channels_linq;
  "channels/message_pipeline": typeof channels_message_pipeline;
  "channels/routing_flow": typeof channels_routing_flow;
  "channels/slack": typeof channels_slack;
  "channels/slack_installations": typeof channels_slack_installations;
  "channels/teams": typeof channels_teams;
  "channels/telegram": typeof channels_telegram;
  "channels/transient_data": typeof channels_transient_data;
  "channels/utils": typeof channels_utils;
  cloudflare_tunnels: typeof cloudflare_tunnels;
  conversations: typeof conversations;
  crons: typeof crons;
  "data/attachments": typeof data_attachments;
  "data/desktop_releases": typeof data_desktop_releases;
  "data/fashion": typeof data_fashion;
  "data/integrations": typeof data_integrations;
  "data/preferences": typeof data_preferences;
  "data/secrets": typeof data_secrets;
  "data/secrets_crypto": typeof data_secrets_crypto;
  "data/secrets_rotation": typeof data_secrets_rotation;
  "data/store_packages": typeof data_store_packages;
  "data/thread_compaction_format": typeof data_thread_compaction_format;
  "data/threads": typeof data_threads;
  "data/user_profiles": typeof data_user_profiles;
  events: typeof events;
  feedback: typeof feedback;
  http: typeof http;
  "http_routes/backups": typeof http_routes_backups;
  "http_routes/connectors": typeof http_routes_connectors;
  "http_routes/desktop_releases": typeof http_routes_desktop_releases;
  "http_routes/dictation": typeof http_routes_dictation;
  "http_routes/media": typeof http_routes_media;
  "http_routes/mobile": typeof http_routes_mobile;
  "http_routes/music": typeof http_routes_music;
  "http_routes/stripe": typeof http_routes_stripe;
  "http_routes/synthesis": typeof http_routes_synthesis;
  "http_routes/voice": typeof http_routes_voice;
  "http_shared/anon_device": typeof http_shared_anon_device;
  "http_shared/cors": typeof http_shared_cors;
  "http_shared/request": typeof http_shared_request;
  "http_shared/sse": typeof http_shared_sse;
  "http_shared/webhook_controls": typeof http_shared_webhook_controls;
  "lib/agent_constants": typeof lib_agent_constants;
  "lib/app_review_auth": typeof lib_app_review_auth;
  "lib/async": typeof lib_async;
  "lib/billing_date": typeof lib_billing_date;
  "lib/billing_money": typeof lib_billing_money;
  "lib/billing_plans": typeof lib_billing_plans;
  "lib/coerce": typeof lib_coerce;
  "lib/context_window": typeof lib_context_window;
  "lib/crypto_utils": typeof lib_crypto_utils;
  "lib/email_i18n": typeof lib_email_i18n;
  "lib/email_templates": typeof lib_email_templates;
  "lib/error_classification": typeof lib_error_classification;
  "lib/http_utils": typeof lib_http_utils;
  "lib/json": typeof lib_json;
  "lib/managed_billing": typeof lib_managed_billing;
  "lib/managed_gateway": typeof lib_managed_gateway;
  "lib/managed_usage": typeof lib_managed_usage;
  "lib/models_dev": typeof lib_models_dev;
  "lib/number_utils": typeof lib_number_utils;
  "lib/object_utils": typeof lib_object_utils;
  "lib/owner_ids": typeof lib_owner_ids;
  "lib/provider_keys": typeof lib_provider_keys;
  "lib/provider_redaction": typeof lib_provider_redaction;
  "lib/providers": typeof lib_providers;
  "lib/rate_limits": typeof lib_rate_limits;
  "lib/redaction": typeof lib_redaction;
  "lib/retry_fetch": typeof lib_retry_fetch;
  "lib/shopify_ucp": typeof lib_shopify_ucp;
  "lib/store_artifacts": typeof lib_store_artifacts;
  "lib/store_icon": typeof lib_store_icon;
  "lib/store_release_reviews": typeof lib_store_release_reviews;
  "lib/text_utils": typeof lib_text_utils;
  "lib/thread_compaction": typeof lib_thread_compaction;
  "lib/tool_call_utils": typeof lib_tool_call_utils;
  "lib/url_security": typeof lib_url_security;
  "lib/validator": typeof lib_validator;
  "lib/welcome_suggestions_parse": typeof lib_welcome_suggestions_parse;
  media_billing: typeof media_billing;
  media_catalog: typeof media_catalog;
  media_contract: typeof media_contract;
  media_fal_webhooks: typeof media_fal_webhooks;
  media_jobs: typeof media_jobs;
  mobile_access: typeof mobile_access;
  mobile_auth: typeof mobile_auth;
  mobile_bridge: typeof mobile_bridge;
  "prompts/discovery_facts": typeof prompts_discovery_facts;
  "prompts/execution": typeof prompts_execution;
  "prompts/index": typeof prompts_index;
  "prompts/invoke": typeof prompts_invoke;
  "prompts/offline_responder": typeof prompts_offline_responder;
  "prompts/registry": typeof prompts_registry;
  "prompts/store_reviews": typeof prompts_store_reviews;
  "prompts/synthesis": typeof prompts_synthesis;
  "prompts/system_assembly": typeof prompts_system_assembly;
  "prompts/thread_compaction": typeof prompts_thread_compaction;
  "prompts/voice_orchestrator": typeof prompts_voice_orchestrator;
  r2_files: typeof r2_files;
  rate_limits: typeof rate_limits;
  reset: typeof reset;
  "runtime_ai/anthropic": typeof runtime_ai_anthropic;
  "runtime_ai/event_stream": typeof runtime_ai_event_stream;
  "runtime_ai/google": typeof runtime_ai_google;
  "runtime_ai/json_parse": typeof runtime_ai_json_parse;
  "runtime_ai/managed": typeof runtime_ai_managed;
  "runtime_ai/model_utils": typeof runtime_ai_model_utils;
  "runtime_ai/openai_completions": typeof runtime_ai_openai_completions;
  "runtime_ai/openai_responses": typeof runtime_ai_openai_responses;
  "runtime_ai/openai_responses_shared": typeof runtime_ai_openai_responses_shared;
  "runtime_ai/sanitize_unicode": typeof runtime_ai_sanitize_unicode;
  "runtime_ai/simple_options": typeof runtime_ai_simple_options;
  "runtime_ai/stream": typeof runtime_ai_stream;
  "runtime_ai/transform_messages": typeof runtime_ai_transform_messages;
  "runtime_ai/types": typeof runtime_ai_types;
  "runtime_ai/usage": typeof runtime_ai_usage;
  "scheduling/cron_jobs": typeof scheduling_cron_jobs;
  "scheduling/desktop_handoff_policy": typeof scheduling_desktop_handoff_policy;
  "schema/agents": typeof schema_agents;
  "schema/auth": typeof schema_auth;
  "schema/backups": typeof schema_backups;
  "schema/billing": typeof schema_billing;
  "schema/conversations": typeof schema_conversations;
  "schema/desktop_releases": typeof schema_desktop_releases;
  "schema/devices": typeof schema_devices;
  "schema/fashion": typeof schema_fashion;
  "schema/feedback": typeof schema_feedback;
  "schema/integrations": typeof schema_integrations;
  "schema/media": typeof schema_media;
  "schema/scheduling": typeof schema_scheduling;
  "schema/social": typeof schema_social;
  "schema/store": typeof schema_store;
  "schema/telemetry": typeof schema_telemetry;
  "schema/users": typeof schema_users;
  shared_validators: typeof shared_validators;
  "social/censor": typeof social_censor;
  "social/messages": typeof social_messages;
  "social/profiles": typeof social_profiles;
  "social/relationships": typeof social_relationships;
  "social/rooms": typeof social_rooms;
  "social/sessions": typeof social_sessions;
  "social/shared": typeof social_shared;
  stella_models: typeof stella_models;
  stella_provider: typeof stella_provider;
  "tools/backend": typeof tools_backend;
  "tools/index": typeof tools_index;
  "tools/types": typeof tools_types;
  "tools/voice_schemas": typeof tools_voice_schemas;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  betterAuth: import("../betterAuth/_generated/component.js").ComponentApi<"betterAuth">;
  rateLimiter: import("@convex-dev/rate-limiter/_generated/component.js").ComponentApi<"rateLimiter">;
  r2: import("@convex-dev/r2/_generated/component.js").ComponentApi<"r2">;
  resend: import("@convex-dev/resend/_generated/component.js").ComponentApi<"resend">;
};
