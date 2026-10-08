import rateLimit from "express-rate-limit";

/**
 * Process-local, per-IP limits for the first-party /api surface. Route-owned
 * limiters (onramp, paymaster, workflows, webacy, ...) live next to their
 * routes.
 */

/** Every /api/ request: 100 per 15 minutes. */
export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: {
    status: "error",
    message: "Too many requests. Please try again later.",
  },
});

/** /api/premium: 10 per minute, on top of the global limit. */
export const premiumLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: {
    status: "error",
    message: "You have exceeded the rate limit for premium routes.",
  },
});
