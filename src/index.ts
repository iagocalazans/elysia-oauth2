import { Elysia } from 'elysia';
import { buildUrl, isTokenValid, redirect } from './utils';
import { CookieOptions, cookie as cookieManager } from '@elysiajs/cookie';
import { JWTOption, jwt as jsonWebToken } from '@elysiajs/jwt';

export type TOAuth2Request<Profile extends string> = {
  /**
   * Check if one or more profiles are valid, i.e. the token exists and has not expired yet
   */
  authorized: (...profiles: Profile[]) => Promise<boolean>;
  // authorize: (...profiles: Profile[]) => Response;
  /**
   * Returns login and logout url of the specified profile(s).
   * Provide no argument to get all URLs of all registered OAuth 2.0 Profiles.
   */
  profiles: <P extends Profile = Profile>(
    ...profiles: P[]
  ) => TOAuth2ProfileUrlMap<P>;
  /**
   * provides the authentication header with bearer token.
   * It is not checked whether the token is still valid, possibly the header is empty.
   *
   * @example
   * if (await ctx.authorized("github")) {
   *  const headers = await ctx.tokenHeaders("github")
   *  fetch("https://api.github.com/user", { headers })
   * }
   */
  tokenHeaders: (profile: Profile) => Promise<{ Authorization: string }>;
};

/**
 * Represents an access token that should be kept in a secure storage.
 *
 * ! numbers may contain floating points (i.e. 1.42)
 */
export type TOAuth2AccessToken = {
  token_type: string;
  scope: string;
  expires_in: number;
  access_token: string;
  created_at: number;
  refresh_token?: string;
  login?: string;
};

/**
 * Represents a (secure) token storage.
 *
 * ! caching of tokens is left to the storage implementation
 */
export interface OAuth2Storage<Profiles extends string> {
  /**
   * Write token to storage (most likely a login)
   */
  set(req: Request, name: Profiles, token: TOAuth2AccessToken): Promise<void>;
  /**
   * Get token from storage
   */
  get(req: Request, name: Profiles, id: string): Promise<TOAuth2AccessToken | undefined>;
  /**
   * Delete token in storage (most likely a logout)
   */
  delete(req: Request, name: Profiles, id: string): Promise<void>;
}

/**
 * Temporary state storage used for [preventing cross-site request forgery attacks](https://datatracker.ietf.org/doc/html/rfc6749#section-10.12)
 */
export interface OAuth2State<Profiles extends string> {
  /**
   * Generate a new unique state
   */
  generate: (req: Request, name: Profiles) => string;
  /**
   * Check if the state exists
   */
  check: (req: Request, name: Profiles, state: string) => boolean;
}

type TPluginParams<Profiles extends string> = {
  /**
   * OAuth2 profiles
   *
   * @example
   * import { github } from '@bogeychan/elysia-oauth2';
import { profile } from '../../../../src/users/users.controller';
   *
   * const profiles = {
   *  github: {
   *    provider: github(),
   *    scope: ['user']
   *  }
   * }
   */
  profiles: { [name in Profiles]: TOAuth2Profile };
  /**
   * Relative path starting at `host` specifying the `login` endpoint
   *
   * @default "/login/:name"
   */
  login?: string;
  /**
   * Relative path starting at `host` specifying the `authorized` endpoint (i.e. oauth-login-callback)
   *
   * @default "/login/:name/authorized"
   */
  authorized?: string;
  /**
   * Relative path starting at `host` specifying the `logout` endpoint
   *
   * @default "/logout/:name"
   */
  logout?: string;
  /**
   * The external host (combination of domain and port).
   *
   * ! The protocol is determined automatically, with localhost `http`, otherwise `https` (required for most providers anyway)
   *
   * @default "localhost:3000"
   */
  host?: string;
  /**
   * The standard prefix of your application if it exists.
   *
   * @default "undefined"
   */
  prefix?: string;
  /**
   * The `redirectTo` path (relative to the `host`) is called when, for example, the user has successfully logged in or logged out
   *
   * @default "/"
   */
  redirectTo?: string;
  /**
   * @see OAuth2State
   */
  state: OAuth2State<Profiles>;
  /**
   * @see OAuth2Storage
   */
  storage: OAuth2Storage<Profiles>;
  /**
   * The JWT options config values
   * 
   * ! It is important to customize this
   *
   * @default { name: 'jwt', secret: 'Fischl von Luftschloss Narfidort', exp: '1h' }
   */
  jwt?: JWTOption;
  /**
   * The Cookie options config values
   * 
   * ! It is important to customize this
   *
   * @default { httpOnly: true, maxAge: 3600, secure: true, secret:  'Fischl von Luftschloss Narfidort', signed: true }
   */
  cookie?: CookieOptions;
};

/**
 * Define your own provider
 */
export type TOAuth2Provider = {
  auth: TOAuth2Url;
  token: TOAuth2Url;
  profile: TOAuth2Url;
  // refresh: TOAuth2Url;

  clientId: string;
  clientSecret: string;
};

const oauth2 = <Profiles extends string>({
  profiles: globalProfiles,
  state,
  login,
  authorized,
  logout,
  host,
  redirectTo,
  storage,
  prefix,
  jwt,
  cookie
}: TPluginParams<Profiles>) => {
  if (!login) {
    login = '/login/:name';
  }

  if (!authorized) {
    authorized = '/login/:name/authorized';
  }

  if (!jwt) {
    jwt = {
      name: 'jwt',
      secret: 'Fischl von Luftschloss Narfidort',
      exp: '1h'
    };
  }

  if (!cookie) {
    cookie = {
      httpOnly: true,
      maxAge: 3600,
      secure: true,
      secret:  'Fischl von Luftschloss Narfidort',
      signed: true
    }
  }

  if (!logout) {
    logout = '/logout/:name';
  }

  if (!host) {
    host = 'localhost:3000';
  }

  if (!redirectTo) {
    redirectTo = '/user/:name/profile';
  }

  type TOAuth2Params = TOAuth2ProviderContext<Profiles>['params'];

  const protocol = host.startsWith('localhost') ? 'http' : 'https';

  function resolveProvider({
    name
  }: TOAuth2ProviderContext<Profiles>['params']): TOAuth2Profile | Response {
    if (!(name in globalProfiles)) {
      return new Response('', { status: 404, statusText: 'Not Found' });
    }
    return globalProfiles[name];
  }

  function buildUri(template: string, name: string, external: boolean = true) {
    const uri = template.replace(':name', name);
    return external ? `${protocol}://${host}${prefix || ""}${uri}` : `${prefix || ""}${uri}`;
  }

  function buildLoginUri(name: string, external: boolean = true) {
    return buildUri(login, name, external);
  }

  function buildLogoutUri(name: string, external: boolean = true) {
    return buildUri(logout, name, external);
  }

  function buildRedirectUri({ name }: TOAuth2Params) {
    return buildUri(authorized, name, true);
  }

  function buildRedirectToUri({ name }: TOAuth2Params) {
    return buildUri(redirectTo, name, true);
  }


  return (
    (
      new Elysia({
        name: '@bogeychan/elysia-oauth2'
      }) as InternalOAuth2Elysia<Profiles>
    )
      .use(
        jsonWebToken(jwt)
      )
      .use(cookieManager(cookie))
      // >>> LOGIN <<<
      .get(login, async (req) => {
        
        const context = resolveProvider(req.params);

        if (context instanceof Response) {
          return context;
        }

        const { provider, scope } = context;

        const authParams = {
          client_id: provider.clientId,
          redirect_uri: buildRedirectUri(req.params),
          response_type: 'code',
          response_mode: 'query',
          state: state.generate(req.request, (req.params as TOAuth2Params).name)
        };

        const authUrl = buildUrl(
          provider.auth.url,
          { ...authParams, ...provider.auth.params },
          scope
          );

        return redirect(authUrl);
      })

      // >>> AUTHORIZED <<<
      .get(authorized, async (req) => {
        const context = resolveProvider(req.params);

        if (context instanceof Response) {
          return context;
        }

        const { provider } = context;

        const { code, state: callbackState } = req.query as {
          code: string;
          state: string;
        };

        if (
          !state.check(
            req.request,
            (req.params as TOAuth2Params).name,
            callbackState
          )
        ) {
          throw new Error('State mismatch');
        }

        const tokenParams = {
          client_id: provider.clientId,
          client_secret: provider.clientSecret,
          redirect_uri: buildRedirectUri(req.params),
          grant_type: 'authorization_code',
          // ! google requires decoded auth code
          code: decodeURIComponent(code)
        };

        const params = new URLSearchParams({
          ...tokenParams,
          ...provider.token.params
        });

        
        // ! required for reddit
        const credentials = btoa(
          provider.clientId + ':' + provider.clientSecret
          );
          
          const response = await fetch(provider.token.url, {
            method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
            Authorization: `Basic ${credentials}`
          },
          body: params.toString()
        });
        
        
        if (
          !response.ok ||
          !response.headers.get('Content-Type')?.startsWith('application/json')
        ) {
          throw new Error(
            `${response.status}: ${
              response.statusText
            }: ${await response.text()}`
          );
        }

        const token = (await response.json()) as TOAuth2AccessToken;
        // ! expires_in is not sent by some providers. a default of one hour is set, which is acceptable.
        // ! https://datatracker.ietf.org/doc/html/rfc6749#section-4.2.2
        token.expires_in = token.expires_in ?? 3600;
        token.created_at = Date.now() / 1000;

        if ((req.params as TOAuth2Params).name === 'twitch') {
          const response = await fetch('https://id.twitch.tv/oauth2/validate', {
            headers: {Authorization: `OAuth ${token.access_token}`}
          })

          if (response.ok) {
            const certificate = await response.json()
            const auth = {...token, ...certificate}
            storage.set(req.request, (req.params as TOAuth2Params).name, auth)

            req.setCookie('authorize', await req.jwt.sign(auth), {maxAge: token.expires_in})
            req.set.status = 'Found'
            req.set.redirect = buildRedirectToUri(req.params)
            return { message: 'Found redirect' }
          }

          throw new Error(
            `${response.status}: ${
              response.statusText
            }: ${await response.text()}`
          );
        }

        storage.set(req.request, (req.params as TOAuth2Params).name, token);
        req.setCookie('authorize', await req.jwt.sign(token as any), {maxAge: token.expires_in})
        req.set.status = 'Found'
        req.set.redirect = buildRedirectToUri(req.params)
        return { message: 'Found redirect' }
        // return redirect(buildRedirectToUri(req.params), req.headers);
      })

      // >>> LOGOUT <<<
      .get(logout, async (req) => {
        const context = resolveProvider(req.params);

        if (context instanceof Response) {
          return context;
        }
        
        req.setCookie('authorize', null, { expires: new Date(Date.now()), maxAge: 0 })

        req.set.status = 'OK'
        req.set.redirect = buildRedirectToUri(req.params)
        return { message: 'Logged out!' }
      })

      .derive((ctx) => {
        return {
          async authorized(...profiles: Profiles[]) {
            for (const profile of profiles) {
              const token: any = await ctx.jwt.verify(ctx.cookie.authorize)

              if (!token) {
                return false
              }
  
              // ! must have for twitch as it could check token authenticity
              if (profile === 'twitch') {
                const response = await fetch('https://id.twitch.tv/oauth2/validate', {
                  headers: {
                    Authorization: `OAuth ${token?.access_token}`
                  }
                })
  
                if (response.ok) {
                  return true
                }
                
                const params = new URLSearchParams({
                  client_id: Bun.env.TWITCH_OAUTH_CLIENT_ID,
                  client_secret: Bun.env.TWITCH_CLIENT_SECRET,
                  refresh_token: token.refresh_token,
                  grant_type: 'refresh_token'
                });

                const newTokenResponse = await fetch('https://id.twitch.tv/oauth2/token', {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    Accept: 'application/json'
                  },
                  body: params.toString()
                });

                if (newTokenResponse.ok) {
                  const newToken = await newTokenResponse.json()
                  storage.set(ctx.request, ('twitch' as TOAuth2Params['name']), newToken);
                  ctx.setCookie('authorize', await ctx.jwt.sign(newToken as unknown))
                  return true;
                }
  
                return false
              }
  
              if (!isTokenValid(token)) {
                return false;
              } 
            }
            return true;
          },
  
          profiles<P extends Profiles = Profiles>(...profiles: P[]) {
            if (profiles.length === 0) {
              profiles = Object.keys(globalProfiles) as P[];
            }
  
            const result = {} as TOAuth2ProfileUrlMap<P>;
  
            for (const profile of profiles) {
              result[profile] = {
                login: buildLoginUri(profile),
                callback: buildRedirectUri({ name: profile }),
                logout: buildLogoutUri(profile),
              };
            }
  
            return result;
          },
  
          async tokenHeaders(profile: Profiles, id: string) {
            const token = await storage.get(ctx.request, profile, id);
            return { Authorization: `Bearer ${token?.access_token}` };
          },
        } as TOAuth2Request<Profiles>;
      })
      
  );
};

export default oauth2;
export * from './providers';

// not relevant, just type declarations...

type TOAuth2ProfileUrlMap<Profiles extends string> = {
  [name in Profiles]: { login: string; callback: string; logout: string; };
};

export type TOAuth2UrlParams = Record<string, string | number | boolean>;

type TOAuth2Url = {
  url: string;
  params: TOAuth2UrlParams;
};

export type TOAuth2Scope = string[];

type TOAuth2Profile = {
  scope: TOAuth2Scope;
  provider: TOAuth2Provider;
};

type TOAuth2ProviderContext<Profiles extends string> = {
  params: {
    name: Profiles;
  };
};

type InternalOAuth2Elysia<Profiles extends string> = Elysia<
  '',
  {
    store: {};
    params: {
      name: Profiles
    };
    request: TOAuth2ProviderContext<Profiles>;
    schema: {};
    error: {};
    meta: {
      schema: {};
      defs: {};
      exposed: {};
    };
  }
>;

