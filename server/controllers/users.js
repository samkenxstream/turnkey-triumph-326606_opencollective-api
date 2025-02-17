import bcrypt from 'bcrypt';
import config from 'config';

import { activities } from '../constants';
import { BadRequest } from '../graphql/errors';
import * as auth from '../lib/auth';
import emailLib from '../lib/email';
import errors from '../lib/errors';
import logger from '../lib/logger';
import RateLimit, { ONE_HOUR_IN_SECONDS } from '../lib/rate-limit';
import { verifyTwoFactorAuthenticationRecoveryCode } from '../lib/two-factor-authentication';
import { validateTOTPToken } from '../lib/two-factor-authentication/totp';
import { isValidEmail, parseToBoolean } from '../lib/utils';
import models from '../models';

const { Unauthorized, ValidationFailed, TooManyRequests } = errors;

const { User } = models;

/**
 *
 * Public methods.
 *
 */

/**
 * Check existence of a user based on email
 */
export const exists = async (req, res) => {
  const email = req.query.email.toLowerCase();
  if (!isValidEmail(email)) {
    return res.send({ exists: false });
  } else {
    const rateLimit = new RateLimit(
      `user_email_search_ip_${req.ip}`,
      config.limits.searchEmailPerHourPerIp,
      ONE_HOUR_IN_SECONDS,
    );
    if (!(await rateLimit.registerCall())) {
      res.send({
        error: { message: 'Rate limit exceeded' },
      });
    }
    const user = await models.User.findOne({
      attributes: ['id'],
      where: { email },
    });
    return res.send({ exists: Boolean(user) });
  }
};

/**
 * Login or create a new user
 *
 * TODO: we are passing createProfile from frontend to specify if we need to
 * create a new account. In the future once signin.js is fully deprecated (replaced by signinV2.js)
 * this function should be refactored to remove createProfile.
 */
export const signin = async (req, res, next) => {
  const { redirect, websiteUrl, sendLink, resetPassword, createProfile = true } = req.body;
  try {
    const rateLimit = new RateLimit(
      `user_signin_attempt_ip_${req.ip}`,
      config.limits.userSigninAttemptsPerHourPerIp,
      ONE_HOUR_IN_SECONDS,
      true,
    );
    if (!(await rateLimit.registerCall())) {
      return res.status(403).send({
        error: { message: 'Rate limit exceeded' },
      });
    }
    let user = await models.User.findOne({ where: { email: req.body.user.email.toLowerCase() } });
    if (!user && !createProfile) {
      return res.status(400).send({
        errorCode: 'EMAIL_DOES_NOT_EXIST',
        message: 'Email does not exist',
      });
    } else if (!user && createProfile) {
      user = await models.User.createUserWithCollective(req.body.user);
    }

    // If password set and not passed, challenge user with password
    if (user.passwordHash && !sendLink && !resetPassword) {
      if (!req.body.user.password) {
        return res.status(403).send({
          errorCode: 'PASSWORD_REQUIRED',
          message: 'Password requested to complete sign in.',
        });
      }
      const validPassword = await bcrypt.compare(req.body.user.password, user.passwordHash);
      if (!validPassword) {
        // Would be great to be consistent in the way we send errors
        // This is what works best with Frontend today
        return res.status(401).send({
          error: { message: 'Invalid password' },
        });
      }

      const twoFactorAuthenticationEnabled = parseToBoolean(config.twoFactorAuthentication.enabled);
      if (twoFactorAuthenticationEnabled && user.twoFactorAuthToken !== null) {
        // Send 2FA token, can only be used to get a long term token
        const token = user.jwt({ scope: 'twofactorauth' }, auth.TOKEN_EXPIRATION_2FA);
        return res.send({ token });
      } else {
        // All good, no 2FA, send token
        const token = await user.generateSessionToken();
        return res.send({ token });
      }
    }

    if (resetPassword) {
      const resetPasswordLink = user.generateResetPasswordLink({ websiteUrl });
      if (config.env === 'development') {
        logger.info(`Reset Password Link: ${resetPasswordLink}`);
      }
      await emailLib.send(
        activities.USER_RESET_PASSWORD,
        user.email,
        { resetPasswordLink, clientIP: req.ip },
        { sendEvenIfNotProduction: true },
      );
    } else {
      const collective = await user.getCollective();
      const loginLink = user.generateLoginLink(redirect || '/', websiteUrl);
      const securitySettingsLink = new URL(loginLink);
      securitySettingsLink.searchParams.set('next', `/${collective.slug}/admin/user-security`);
      if (config.env === 'development') {
        logger.info(`Login Link: ${loginLink}`);
      }
      await emailLib.send(
        activities.USER_NEW_TOKEN,
        user.email,
        { loginLink, clientIP: req.ip, noPassword: !user.passwordHash, securitySettingsLink },
        { sendEvenIfNotProduction: true },
      );

      // For e2e testing, we enable testuser+(admin|member)@opencollective.com to automatically receive the login link
      if (config.env !== 'production' && user.email.match(/.*test.*@opencollective.com$/)) {
        return res.send({ success: true, redirect: loginLink });
      }
    }

    res.send({ success: true });
  } catch (e) {
    next(e);
  }
};

/**
 * Receive a login JWT and generate another one.
 * This can be used right after the first login.
 * Also check if the user has two-factor authentication
 * enabled on their account, and if they do, we send
 * back a JWT with scope 'twofactorauth' to trigger
 * the 2FA flow on the frontend
 */
export const updateToken = async (req, res) => {
  const twoFactorAuthenticationEnabled = parseToBoolean(config.twoFactorAuthentication.enabled);
  if (twoFactorAuthenticationEnabled && req.remoteUser.twoFactorAuthToken !== null) {
    const token = req.remoteUser.jwt(
      { scope: 'twofactorauth', sessionId: req.jwtPayload?.sessionId },
      auth.TOKEN_EXPIRATION_2FA,
    );
    res.send({ token });
  } else {
    const token = await req.remoteUser.generateSessionToken({ sessionId: req.jwtPayload?.sessionId });
    res.send({ token });
  }
};

/**
 * Verify the 2FA code or recovery code the user has entered when logging in and send back another JWT.
 */
export const twoFactorAuthAndUpdateToken = async (req, res, next) => {
  const { twoFactorAuthenticatorCode, twoFactorAuthenticationRecoveryCode } = req.body;

  const userId = Number(req.jwtPayload.sub);
  const sessionId = req.jwtPayload.sessionId;

  // Both 2FA and recovery codes rate limited to 10 tries per hour
  const rateLimit = new RateLimit(`user_2FA_endpoint_${userId}`, 10, ONE_HOUR_IN_SECONDS);
  const fail = async exception => {
    await rateLimit.registerCall();
    next(exception);
  };

  if (await rateLimit.hasReachedLimit()) {
    return next(new TooManyRequests('Too many attempts. Please try again in an hour'));
  }

  const user = await User.findByPk(userId);
  if (!user) {
    logger.warn(`User id ${userId} not found`);
    next();
    return;
  }

  if (twoFactorAuthenticatorCode) {
    // if there is a 2FA code, we need to verify it before returning the token
    const verified = validateTOTPToken(user.twoFactorAuthToken, twoFactorAuthenticatorCode);
    if (!verified) {
      return fail(new Unauthorized('Two-factor authentication code failed. Please try again'));
    }
  } else if (twoFactorAuthenticationRecoveryCode) {
    // or if there is a recovery code try to verify it
    if (typeof twoFactorAuthenticationRecoveryCode !== 'string') {
      return fail(new ValidationFailed('2FA recovery code must be a string'));
    }
    const verified = verifyTwoFactorAuthenticationRecoveryCode(
      user.twoFactorAuthRecoveryCodes,
      twoFactorAuthenticationRecoveryCode,
    );
    if (!verified) {
      return fail(new Unauthorized('Two-factor authentication recovery code failed. Please try again'));
    }

    await user.update({ twoFactorAuthRecoveryCodes: null, twoFactorAuthToken: null });
  } else {
    return fail(new BadRequest('This endpoint requires you to provide a 2FA code or a recovery code'));
  }

  const token = await user.generateSessionToken({ sessionId });
  res.send({ token: token });
};
