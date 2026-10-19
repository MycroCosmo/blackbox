# Spring integration

Use the runnable [spring-local example](spring-local/README.md). Its optional
[BlackboxAdapter.java](spring-local/src/main/java/dev/blackbox/BlackboxAdapter.java)
replaces the earlier synchronous HTTP snippet: a bounded background queue sends
completed requests, exceptions, causes and request-local Logback messages.

Copy the adapter into an existing Spring Boot 3 Servlet application with the web
starter (Jackson + Logback), under its component scan. Enable only the `local`
profile. There is no Java agent or Scouter installation. See the example for the
explicit async propagation contract and collection limits.
