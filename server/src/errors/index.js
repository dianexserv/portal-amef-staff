// Erori custom pentru întregul backend.
//
// De ce clase separate (nu un singur AppError cu cod) — aplicarea principiului
// „eroarea își poartă singură politica HTTP": cine aruncă `NotFoundError` nu
// trebuie să știe că asta înseamnă 404 (middleware-ul de erori traduce).
// Asta evită try/catch în fiecare route + permite unit-testarea serviciilor
// fără cunoștințe despre Express.
//
// `code` separat de `statusCode` ca front-end-ul să poată face logică
// programatică pe `code` (ex: "CONFLICT" → afișează modal de overwrite),
// fără să parseze mesajul tradus.
//
// `details` (opțional) — payload structurat folosit la VALIDATION_ERROR ca
// să trimitem lista de field-uri invalide; e omis din răspuns dacă lipsește.

class AppError extends Error {
  constructor(message, statusCode, code, details) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.code = code;
    if (details !== undefined) {
      this.details = details;
    }
    // Capturăm stack-ul fără frame-ul constructorului — util la triage,
    // logul ajunge la rândul de cod care a aruncat efectiv.
    if (typeof Error.captureStackTrace === 'function') {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

class ValidationError extends AppError {
  constructor(message, details) {
    super(message, 400, 'VALIDATION_ERROR', details);
  }
}

class UnauthorizedError extends AppError {
  constructor(message, details) {
    super(message, 401, 'UNAUTHORIZED', details);
  }
}

class ForbiddenError extends AppError {
  constructor(message, details) {
    super(message, 403, 'FORBIDDEN', details);
  }
}

class NotFoundError extends AppError {
  constructor(message, details) {
    super(message, 404, 'NOT_FOUND', details);
  }
}

class ConflictError extends AppError {
  constructor(message, details) {
    super(message, 409, 'CONFLICT', details);
  }
}

module.exports = {
  AppError,
  ValidationError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
};
