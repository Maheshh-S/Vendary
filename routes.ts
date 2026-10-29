/** 
 * The Default Redirect path after logging in
 * @type {string}
*/
export const DEFAULT_LOGIN_REDIRECT = '/'


/** 
 * The prefix for api authentication routes
 * The routes that starts with this prefix are used for api authentication purposes
 * @type {string}
*/
export const apiAuthPrefix = '/api/auth' //TODO: Change back to /api/auth


/** 
 * Thes routes are used for authentication purposes
 * The route will authenticate the users to /dashboard
 * @type {string}
*/
export const authRoutes = [
    '/login',
    '/register',
    '/error',
]

/**
 * Thes routes dont require authentication
 * The routes are accessible to public
 * NOTE: /checkout is deliberately NOT public — guests must sign in before
 * payment (PlaceOrder requires a session; paying first would dead-end).
*/
export const publicRoutes = [
    '/',
    '/new-verification',
    '/password/reset',
    '/changelog',
    '/products',
    '/products/(.*)',
    '/licence',
    '/privacy',
    '/returns',
    '/terms-of-service',
    '/success',
    '/cart'
]