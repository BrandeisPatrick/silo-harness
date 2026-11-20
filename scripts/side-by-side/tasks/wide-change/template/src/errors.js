class NotFoundError extends Error {
  constructor(kind, id) {
    super(`no ${kind} with id ${id}`);
    this.name = 'NotFoundError';
  }
}

class ConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConflictError';
  }
}

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

module.exports = { NotFoundError, ConflictError, ValidationError };
