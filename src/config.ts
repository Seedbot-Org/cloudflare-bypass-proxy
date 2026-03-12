export const config = {
	PORT: parseInt(process.env.PORT || '3003', 10),
	CORS_ORIGINS: process.env.CORS_ORIGINS?.split(',') || ['*'],
	REQUEST_TIMEOUT: parseInt(process.env.REQUEST_TIMEOUT || '60000', 10),
	API_KEY: process.env.API_KEY || '', // Optional API key for auth
};
