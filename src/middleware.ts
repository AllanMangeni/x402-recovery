import { Request, Response, NextFunction } from 'express';

export function createMiddleware() {
  return (_req: Request, res: Response, next: NextFunction) => {
    next();
  };
}
