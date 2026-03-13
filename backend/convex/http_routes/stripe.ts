import Stripe from "stripe";
import type { HttpRouter } from "convex/server";
import { httpAction } from "../_generated/server";
import { internal } from "../_generated/api";

const STRIPE_API_VERSION = "2026-02-25.clover";

const toSafeString = (value: string | null | undefined) => value?.trim() ?? "";

const toPaidPlan = (value: string | null | undefined) => {
  const normalized = value?.trim().toLowerCase();
  return normalized === "go" || normalized === "pro" || normalized === "plus"
    ? normalized
    : undefined;
};

const getStripeClient = () => {
  const secret = process.env.STRIPE_SECRET_KEY?.trim();
  if (!secret) {
    throw new Error("Missing STRIPE_SECRET_KEY");
  }

  return new Stripe(secret, {
    apiVersion: STRIPE_API_VERSION,
    httpClient: Stripe.createFetchHttpClient(),
  });
};

const getWebhookSecret = () => {
  const secret = process.env.STRIPE_WEBHOOK_SECRET?.trim();
  if (!secret) {
    throw new Error("Missing STRIPE_WEBHOOK_SECRET");
  }
  return secret;
};

const toPeriodMs = (value: number | null | undefined) =>
  typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value * 1000)
    : undefined;

const normalizePaymentMethod = async (
  stripe: Stripe,
  paymentMethod: string | Stripe.PaymentMethod | null,
) => {
  if (!paymentMethod) {
    return {
      id: "",
      brand: "",
      last4: "",
    };
  }

  if (typeof paymentMethod === "string") {
    try {
      const fetched = await stripe.paymentMethods.retrieve(paymentMethod);
      return {
        id: fetched.id,
        brand: fetched.card?.brand ?? "",
        last4: fetched.card?.last4 ?? "",
      };
    } catch {
      return {
        id: paymentMethod,
        brand: "",
        last4: "",
      };
    }
  }

  return {
    id: paymentMethod.id,
    brand: paymentMethod.card?.brand ?? "",
    last4: paymentMethod.card?.last4 ?? "",
  };
};

export const registerStripeRoutes = (http: HttpRouter) => {
  http.route({
    path: "/api/stripe/webhook",
    method: "POST",
    handler: httpAction(async (ctx, request) => {
      let stripe: Stripe;
      let webhookSecret: string;

      try {
        stripe = getStripeClient();
        webhookSecret = getWebhookSecret();
      } catch (error) {
        console.error("[stripe-webhook] Missing Stripe configuration", error);
        return new Response("Stripe is not configured", { status: 503 });
      }

      const signature = request.headers.get("stripe-signature");
      if (!signature) {
        return new Response("Missing stripe-signature header", { status: 400 });
      }

      const payload = await request.text();
      let event: Stripe.Event;

      try {
        event = await stripe.webhooks.constructEventAsync(payload, signature, webhookSecret);
      } catch (error) {
        console.error("[stripe-webhook] Signature verification failed", error);
        return new Response("Invalid Stripe signature", { status: 400 });
      }

      const eventObject = event.data.object as unknown as Record<string, unknown>;
      const eventCustomerId = toSafeString(
        typeof eventObject.customer === "string" ? eventObject.customer : undefined,
      );
      const eventSubscriptionId = toSafeString(
        typeof eventObject.id === "string" && event.type.startsWith("customer.subscription")
          ? eventObject.id
          : typeof eventObject.subscription === "string"
            ? eventObject.subscription
            : undefined,
      );

      const dedup = await ctx.runMutation(internal.billing.recordStripeEvent, {
        eventId: event.id,
        eventType: event.type,
        ownerId: undefined,
        stripeCustomerId: eventCustomerId || undefined,
        stripeSubscriptionId: eventSubscriptionId || undefined,
        createdAt: toPeriodMs(event.created) ?? Date.now(),
      });

      if (!dedup.accepted) {
        return new Response(JSON.stringify({ received: true, duplicate: true }), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
          },
        });
      }

      try {
        switch (event.type) {
          case "checkout.session.completed": {
            const session = event.data.object as Stripe.Checkout.Session;
            if (session.mode !== "subscription") {
              break;
            }

            const ownerId = toSafeString(session.metadata?.ownerId);
            const requestedPlan = toPaidPlan(session.metadata?.plan);
            const customerId = toSafeString(
              typeof session.customer === "string" ? session.customer : undefined,
            );
            const subscriptionId = toSafeString(
              typeof session.subscription === "string" ? session.subscription : undefined,
            );

            if (ownerId && customerId) {
              await ctx.runMutation(internal.billing.linkStripeCustomerToOwner, {
                ownerId,
                stripeCustomerId: customerId,
              });
            }

            if (subscriptionId) {
              const subscription = await stripe.subscriptions.retrieve(subscriptionId, {
                expand: ["default_payment_method"],
              });

              const paymentMethod = await normalizePaymentMethod(
                stripe,
                subscription.default_payment_method,
              );
              const priceId = toSafeString(
                subscription.items.data[0]?.price?.id,
              );

              const firstItem = subscription.items.data[0];
              await ctx.runMutation(internal.billing.syncSubscriptionFromStripe, {
                ownerId: ownerId || undefined,
                stripeCustomerId: customerId,
                stripeSubscriptionId: subscription.id,
                stripePriceId: priceId || undefined,
                requestedPlan,
                subscriptionStatus: subscription.status,
                cancelAtPeriodEnd: subscription.cancel_at_period_end,
                currentPeriodStart: toPeriodMs(firstItem?.current_period_start),
                currentPeriodEnd: toPeriodMs(firstItem?.current_period_end),
                defaultPaymentMethodId: paymentMethod.id || undefined,
                paymentMethodBrand: paymentMethod.brand || undefined,
                paymentMethodLast4: paymentMethod.last4 || undefined,
              });
            }

            break;
          }

          case "customer.subscription.created":
          case "customer.subscription.updated":
          case "customer.subscription.deleted": {
            const subscription = event.data.object as Stripe.Subscription;
            const customerId = toSafeString(
              typeof subscription.customer === "string" ? subscription.customer : undefined,
            );
            const requestedPlan = toPaidPlan(subscription.metadata?.plan);
            const ownerId = toSafeString(subscription.metadata?.ownerId);
            const firstItem = subscription.items.data[0];
            const priceId = toSafeString(firstItem?.price?.id);
            const paymentMethod = await normalizePaymentMethod(
              stripe,
              subscription.default_payment_method,
            );

            await ctx.runMutation(internal.billing.syncSubscriptionFromStripe, {
              ownerId: ownerId || undefined,
              stripeCustomerId: customerId,
              stripeSubscriptionId: subscription.id,
              stripePriceId: priceId || undefined,
              requestedPlan,
              subscriptionStatus: subscription.status,
              cancelAtPeriodEnd: subscription.cancel_at_period_end,
              currentPeriodStart: toPeriodMs(firstItem?.current_period_start),
              currentPeriodEnd: toPeriodMs(firstItem?.current_period_end),
              defaultPaymentMethodId: paymentMethod.id || undefined,
              paymentMethodBrand: paymentMethod.brand || undefined,
              paymentMethodLast4: paymentMethod.last4 || undefined,
            });
            break;
          }

          case "customer.updated": {
            const customer = event.data.object as Stripe.Customer;
            if (customer.deleted) {
              break;
            }

            const customerId = toSafeString(customer.id);
            const defaultPaymentMethod = customer.invoice_settings.default_payment_method;
            const paymentMethod = await normalizePaymentMethod(
              stripe,
              typeof defaultPaymentMethod === "string" ? defaultPaymentMethod : null,
            );

            if (customerId) {
              await ctx.runMutation(internal.billing.updatePaymentMethodForCustomer, {
                stripeCustomerId: customerId,
                defaultPaymentMethodId: paymentMethod.id || undefined,
                paymentMethodBrand: paymentMethod.brand || undefined,
                paymentMethodLast4: paymentMethod.last4 || undefined,
              });
            }

            break;
          }

          case "invoice.payment_succeeded":
          case "invoice.payment_failed":
          case "invoice.payment_action_required": {
            const invoice = event.data.object as Stripe.Invoice;
            const customerId = toSafeString(
              typeof invoice.customer === "string" ? invoice.customer : undefined,
            );

            const subDetails = invoice.parent?.subscription_details;
            const rawSub = subDetails?.subscription;
            const subscriptionId = typeof rawSub === "string" ? rawSub : rawSub?.id;

            await ctx.runMutation(internal.billing.recordInvoicePayment, {
              ownerId: toSafeString(invoice.metadata?.ownerId) || undefined,
              stripeCustomerId: customerId || undefined,
              stripeInvoiceId: invoice.id,
              stripePaymentIntentId: undefined,
              stripeSubscriptionId: toSafeString(subscriptionId) || undefined,
              amountPaidCents: Math.max(0, Math.floor(invoice.amount_paid ?? 0)),
              currency: invoice.currency ?? "usd",
              billingReason: invoice.billing_reason ?? "unknown",
              status: invoice.status ?? "unknown",
              periodStart: toPeriodMs(invoice.period_start),
              periodEnd: toPeriodMs(invoice.period_end),
            });
            break;
          }

          default:
            break;
        }
      } catch (error) {
        console.error("[stripe-webhook] Event handling failed", {
          eventId: event.id,
          eventType: event.type,
          error,
        });

        await ctx.runMutation(internal.billing.deleteStripeEvent, {
          eventId: event.id,
        });

        return new Response("Webhook processing failed", { status: 500 });
      }

      return new Response(JSON.stringify({ received: true }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      });
    }),
  });
};
