/** A delivery that failed: the HTTP status when there was a response, the error code when there was none. */
class DeliveryError extends Error {
  constructor(message, { status = null, code = null } = {}) {
    super(message);
    this.name = 'DeliveryError';
    this.status = status;
    this.code = code;
  }
}

module.exports = { DeliveryError };
