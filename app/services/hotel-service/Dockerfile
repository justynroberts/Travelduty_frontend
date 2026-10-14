# Build context: repository root
#   docker build -f services/hotel-service/Dockerfile -t travelduty/hotel-service .
FROM maven:3.9-eclipse-temurin-17 AS build
WORKDIR /src
COPY services/hotel-service/pom.xml .
RUN mvn -q -B dependency:go-offline
COPY services/hotel-service/src src
RUN mvn -q -B -DskipTests package

FROM eclipse-temurin:17-jre
RUN groupadd --system app && useradd --system --gid app --home /app app
WORKDIR /app
COPY --from=build /src/target/hotel-service.jar app.jar
COPY data/airports.json data/airports.json
ENV PORT=8083 \
    REFERENCE_DATA_DIR=/app/data \
    JAVA_TOOL_OPTIONS="-XX:MaxRAMPercentage=75 -XX:+ExitOnOutOfMemoryError"
USER app
EXPOSE 8083
ENTRYPOINT ["java", "-jar", "/app/app.jar"]
