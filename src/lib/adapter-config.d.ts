// This file extends the AdapterConfig type from "@types/iobroker"

// Augment the globally declared type ioBroker.AdapterConfig
declare global {
    namespace ioBroker {
        interface AdapterConfig {
            /** API key for the legacy v1 REST API (account settings -> generate API key) */
            apiKey: string;
            /** Poll interval for the v1 REST API in seconds */
            apiInterval: number;
            /** Poll interval for customerdetails.php in minutes (rate limited to 5 requests per 5 minutes) */
            customerInterval: number;
            /** Enable the Hydrawise v2 API (OAuth2 + GraphQL) */
            useV2: boolean;
            /** Hydrawise account e-mail (v2 API) */
            email: string;
            /** Hydrawise account password (v2 API, stored encrypted) */
            password: string;
            /** Poll interval for the v2 API in minutes */
            v2Interval: number;
            /** Controller id to query, 0 = first controller of the account */
            v2ControllerId: number;
            /** Create weather/rainfall states from the controller's weather station */
            v2Weather: boolean;
            /** Volume per day that may flow without any zone running before water.leakSuspected is set, 0 disables the check */
            leakThreshold: number;
        }
    }
}

// this is required so the above AdapterConfig is found by TypeScript / type checking
export {};
