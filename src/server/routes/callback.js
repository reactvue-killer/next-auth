// Handle callbacks from login services
import oAuthCallback from '../lib/oauth/callback'
import callbackHandler from '../lib/callback-handler'
import cookie from '../lib/cookie'
import logger from '../../lib/logger'
import dispatchEvent from '../lib/dispatch-event'

export default async (req, res, options, done) => {
  const {
    provider: providerName,
    providers,
    adapter,
    baseUrl,
    basePath,
    secret,
    cookies,
    callbackUrl,
    pages,
    jwt,
    events,
    callbacks,
    csrfToken,
    redirect
  } = options
  const provider = providers[providerName]
  const { type } = provider
  const useJwtSession = options.session.jwt
  const sessionMaxAge = options.session.maxAge

  // Get session ID (if set)
  const sessionToken = req.cookies ? req.cookies[cookies.sessionToken.name] : null

  if (type === 'oauth') {
    try {
      oAuthCallback(req, provider, csrfToken, async (error, profile, account, OAuthProfile) => {
        try {
          if (error) {
            logger.error('CALLBACK_OAUTH_ERROR', error)
            return redirect(`${baseUrl}${basePath}/error?error=oAuthCallback`)
          }

          // Make it easier to debug when adding a new provider
          logger.debug('OAUTH_CALLBACK_RESPONSE', { profile, account, OAuthProfile })

          // If we don't have a profile object then either something went wrong
          // or the user cancelled signin in. We don't know which, so we just
          // direct the user to the signup page for now. We could do something
          // else in future.
          //
          // Note: In oAuthCallback an error is logged with debug info, so it
          // should at least be visible to developers what happened if it is an
          // error with the provider.
          if (!profile) {
            return redirect(`${baseUrl}${basePath}/signin`)
          }

          // Check if user is allowed to sign in
          // Attempt to get Profile from OAuth provider details before invoking
          // signIn callback - but if no user object is returned, that is fine
          // (that just means it's a new user signing in for the first time).
          let userOrProfile = profile
          if (adapter) {
            const { getUserByProviderAccountId } = await adapter.getAdapter(options)
            const userFromProviderAccountId = await getUserByProviderAccountId(account.provider, account.id)
            if (userFromProviderAccountId) {
              userOrProfile = userFromProviderAccountId
            }
          }

          try {
            const signInCallbackResponse = await callbacks.signIn(userOrProfile, account, OAuthProfile)
            if (signInCallbackResponse === false) {
              return redirect(`${baseUrl}${basePath}/error?error=AccessDenied`)
            }
          } catch (error) {
            if (error instanceof Error) {
              return redirect(`${baseUrl}${basePath}/error?error=${encodeURIComponent(error)}`)
            } else {
              return redirect(error)
            }
          }

          // Sign user in
          const { user, session, isNewUser } = await callbackHandler(sessionToken, profile, account, options)

          if (useJwtSession) {
            const defaultJwtPayload = {
              name: user.name,
              email: user.email,
              picture: user.image
            }
            const jwtPayload = await callbacks.jwt(defaultJwtPayload, user, account, OAuthProfile, isNewUser)

            // Sign and encrypt token
            const newEncodedJwt = await jwt.encode({ ...jwt, token: jwtPayload })

            // Set cookie expiry date
            const cookieExpires = new Date()
            cookieExpires.setTime(cookieExpires.getTime() + (sessionMaxAge * 1000))

            cookie.set(res, cookies.sessionToken.name, newEncodedJwt, { expires: cookieExpires.toISOString(), ...cookies.sessionToken.options })
          } else {
            // Save Session Token in cookie
            cookie.set(res, cookies.sessionToken.name, session.sessionToken, { expires: session.expires || null, ...cookies.sessionToken.options })
          }

          await dispatchEvent(events.signIn, { user, account, isNewUser })

          // Handle first logins on new accounts
          // e.g. option to send users to a new account landing page on initial login
          // Note that the callback URL is preserved, so the journey can still be resumed
          if (isNewUser && pages.newUser) {
            return redirect(pages.newUser)
          }

          // Callback URL is already verified at this point, so safe to use if specified
          return redirect(callbackUrl || baseUrl)
        } catch (error) {
          if (error.name === 'AccountNotLinkedError') {
            // If the email on the account is already linked, but nto with this oAuth account
            return redirect(`${baseUrl}${basePath}/error?error=OAuthAccountNotLinked`)
          } else if (error.name === 'CreateUserError') {
            return redirect(`${baseUrl}${basePath}/error?error=OAuthCreateAccount`)
          } else {
            logger.error('OAUTH_CALLBACK_HANDLER_ERROR', error)
            return redirect(`${baseUrl}${basePath}/error?error=Callback`)
          }
        }
      })
    } catch (error) {
      logger.error('OAUTH_CALLBACK_ERROR', error)
      return redirect(`${baseUrl}${basePath}/error?error=Callback`)
    }
  } else if (type === 'email') {
    try {
      if (!adapter) {
        logger.error('EMAIL_REQUIRES_ADAPTER_ERROR')
        return redirect(`${baseUrl}${basePath}/error?error=Configuration`)
      }

      const { getVerificationRequest, deleteVerificationRequest, getUserByEmail } = await adapter.getAdapter(options)
      const verificationToken = req.query.token
      const email = req.query.email

      // Verify email and verification token exist in database
      const invite = await getVerificationRequest(email, verificationToken, secret, provider)
      if (!invite) {
        return redirect(`${baseUrl}${basePath}/error?error=Verification`)
      }

      // If verification token is valid, delete verification request token from
      // the database so it cannot be used again
      await deleteVerificationRequest(email, verificationToken, secret, provider)

      // If is an existing user return a user object (otherwise use placeholder)
      const profile = await getUserByEmail(email) || { email }
      const account = { id: provider.id, type: 'email', providerAccountId: email }

      // Check if user is allowed to sign in
      try {
        const signInCallbackResponse = await callbacks.signIn(profile, account, { email })
        if (signInCallbackResponse === false) {
          return redirect(`${baseUrl}${basePath}/error?error=AccessDenied`)
        }
      } catch (error) {
        if (error instanceof Error) {
          return redirect(`${baseUrl}${basePath}/error?error=${encodeURIComponent(error)}`)
        } else {
          return redirect(error)
        }
      }

      // Sign user in
      const { user, session, isNewUser } = await callbackHandler(sessionToken, profile, account, options)

      if (useJwtSession) {
        const defaultJwtPayload = {
          name: user.name,
          email: user.email,
          picture: user.image
        }
        const jwtPayload = await callbacks.jwt(defaultJwtPayload, user, account, profile, isNewUser)

        // Sign and encrypt token
        const newEncodedJwt = await jwt.encode({ ...jwt, token: jwtPayload })

        // Set cookie expiry date
        const cookieExpires = new Date()
        cookieExpires.setTime(cookieExpires.getTime() + (sessionMaxAge * 1000))

        cookie.set(res, cookies.sessionToken.name, newEncodedJwt, { expires: cookieExpires.toISOString(), ...cookies.sessionToken.options })
      } else {
        // Save Session Token in cookie
        cookie.set(res, cookies.sessionToken.name, session.sessionToken, { expires: session.expires || null, ...cookies.sessionToken.options })
      }

      await dispatchEvent(events.signIn, { user, account, isNewUser })

      // Handle first logins on new accounts
      // e.g. option to send users to a new account landing page on initial login
      // Note that the callback URL is preserved, so the journey can still be resumed
      if (isNewUser && pages.newUser) {
        return redirect(pages.newUser)
      }

      // Callback URL is already verified at this point, so safe to use if specified
      if (callbackUrl) {
        return redirect(callbackUrl)
      } else {
        return redirect(baseUrl)
      }
    } catch (error) {
      if (error.name === 'CreateUserError') {
        return redirect(`${baseUrl}${basePath}/error?error=EmailCreateAccount`)
      } else {
        logger.error('CALLBACK_EMAIL_ERROR', error)
        return redirect(`${baseUrl}${basePath}/error?error=Callback`)
      }
    }
  } else if (type === 'credentials' && req.method === 'POST') {
    if (!useJwtSession) {
      logger.error('CALLBACK_CREDENTIALS_JWT_ERROR', 'Signin in with credentials is only supported if JSON Web Tokens are enabled')
      return redirect(`${baseUrl}${basePath}/error?error=Configuration`)
    }

    if (!provider.authorize) {
      logger.error('CALLBACK_CREDENTIALS_HANDLER_ERROR', 'Must define an authorize() handler to use credentials authentication provider')
      return redirect(`${baseUrl}${basePath}/error?error=Configuration`)
    }

    const credentials = req.body

    let userObjectReturnedFromAuthorizeHandler
    try {
      userObjectReturnedFromAuthorizeHandler = await provider.authorize(credentials)
      if (!userObjectReturnedFromAuthorizeHandler) {
        return redirect(`${baseUrl}${basePath}/error?error=CredentialsSignin&provider=${encodeURIComponent(provider.id)}`)
      }
    } catch (error) {
      if (error instanceof Error) {
        return redirect(`${baseUrl}${basePath}/error?error=${encodeURIComponent(error)}`)
      } else {
        return redirect(error)
      }
    }

    const user = userObjectReturnedFromAuthorizeHandler
    const account = { id: provider.id, type: 'credentials' }

    try {
      const signInCallbackResponse = await callbacks.signIn(user, account, credentials)
      if (signInCallbackResponse === false) {
        return redirect(`${baseUrl}${basePath}/error?error=AccessDenied`)
      }
    } catch (error) {
      if (error instanceof Error) {
        return redirect(`${baseUrl}${basePath}/error?error=${encodeURIComponent(error)}`)
      } else {
        return redirect(error)
      }
    }

    const defaultJwtPayload = {
      name: user.name,
      email: user.email,
      picture: user.image
    }
    const jwtPayload = await callbacks.jwt(defaultJwtPayload, user, account, userObjectReturnedFromAuthorizeHandler, false)

    // Sign and encrypt token
    const newEncodedJwt = await jwt.encode({ ...jwt, token: jwtPayload })

    // Set cookie expiry date
    const cookieExpires = new Date()
    cookieExpires.setTime(cookieExpires.getTime() + (sessionMaxAge * 1000))

    cookie.set(res, cookies.sessionToken.name, newEncodedJwt, { expires: cookieExpires.toISOString(), ...cookies.sessionToken.options })

    await dispatchEvent(events.signIn, { user, account })

    return redirect(callbackUrl || baseUrl)
  } else {
    res.status(500).end(`Error: Callback for provider type ${type} not supported`)
    return done()
  }
}
