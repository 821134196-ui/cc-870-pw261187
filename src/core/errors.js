/**
 * 网关统一错误类型。
 * GatewayError  -> 正常的可预期拒绝（配置错误、闸门拦截等），带 HTTP 状态码
 * ValidationRejection -> 本地规则校验插件短路请求
 */
export class GatewayError extends Error {
  constructor(status, code, message, details = undefined) {
    super(message);
    this.name = 'GatewayError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export class ValidationRejection extends Error {
  constructor(violations, chainTrace) {
    super('local rule validation failed');
    this.name = 'ValidationRejection';
    this.status = 422;
    this.code = 'validation_failed';
    this.violations = violations;
    this.chainTrace = chainTrace;
  }
}
