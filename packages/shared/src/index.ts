export interface HealthResponse {
  status: 'ok';
}

export interface ApiError {
  statusCode: number;
  message: string;
}
