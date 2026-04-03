import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from "@nestjs/common";
import { Observable, tap, catchError, throwError } from "rxjs";
import { MetricsService } from "./metrics.service";

@Injectable()
export class MetricsInterceptor implements NestInterceptor {
  constructor(private readonly metrics: MetricsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const http = context.switchToHttp();
    const request = http.getRequest();
    const method: string = request.method;
    const path: string = request.url;

    const end = this.metrics.httpRequestDuration.startTimer({ method, path });

    return next.handle().pipe(
      tap(() => {
        const response = http.getResponse();
        const status = String(response.statusCode);
        end();
        this.metrics.httpRequestsTotal.inc({ method, path, status });
      }),
      catchError((err) => {
        end();
        this.metrics.httpRequestsTotal.inc({ method, path, status: "500" });
        return throwError(() => err);
      }),
    );
  }
}
