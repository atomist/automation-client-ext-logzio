/*
 * Copyright © 2018 Atomist, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {
    AutomationContextAware,
    Configuration,
    EventFired,
    HandlerContext,
    HandlerResult,
    logger,
} from "@atomist/automation-client";
import { CommandInvocation } from "@atomist/automation-client/internal/invoker/Payload";
import {
    CommandIncoming,
    EventIncoming,
} from "@atomist/automation-client/internal/transport/RequestProcessor";
import * as nsp from "@atomist/automation-client/internal/util/cls";
import { AutomationContext } from "@atomist/automation-client/internal/util/cls";
import {
    AutomationEventListener,
    AutomationEventListenerSupport,
} from "@atomist/automation-client/server/AutomationEventListener";
import {
    Destination,
    MessageOptions,
} from "@atomist/automation-client/spi/message/MessageClient";
import * as _ from "lodash";
import * as os from "os";
import * as serializeError from "serialize-error";

export interface LogzioOptions {
    token: string;
    name: string;
    version: string;
    environment: string;
    application: string;
}

export class LogzioAutomationEventListener extends AutomationEventListenerSupport
    implements AutomationEventListener {

    private logzio: any;

    constructor(options: LogzioOptions) {
        super();
        this.initLogzioLogging(options);
    }

    public commandIncoming(payload: CommandIncoming) {
        this.sendEvent("Incoming command", "request", payload, nsp.get());
    }

    public commandStarting(payload: CommandInvocation,
                           ctx: HandlerContext) {
        this.sendOperation("CommandHandler", "operation", "command-handler",
            payload.name, "starting", (ctx as any as AutomationContextAware).context);
    }

    public commandSuccessful(payload: CommandInvocation,
                             ctx: HandlerContext,
                             result: HandlerResult): Promise<any> {
        this.sendOperation("CommandHandler", "operation", "command-handler",
            payload.name, "successful", (ctx as any as AutomationContextAware).context, result);
        return Promise.resolve();
    }

    public commandFailed(payload: CommandInvocation,
                         ctx: HandlerContext,
                         err: any): Promise<any> {
        this.sendOperation("CommandHandler", "operation", "command-handler",
            payload.name, "failed", (ctx as any as AutomationContextAware).context, err);
        return Promise.resolve();
    }

    public eventIncoming(payload: EventIncoming) {
        this.sendEvent("Incoming event", "event", payload, nsp.get());
    }

    public eventStarting(payload: EventFired<any>,
                         ctx: HandlerContext) {
        this.sendOperation("EventHandler", "operation", "event-handler",
            payload.extensions.operationName, "starting", (ctx as any as AutomationContextAware).context);
    }

    public eventSuccessful(payload: EventFired<any>,
                           ctx: HandlerContext,
                           result: HandlerResult[]): Promise<any> {
        this.sendOperation("EventHandler", "operation", "event-handler",
            payload.extensions.operationName, "successful", (ctx as any as AutomationContextAware).context, result);
        return Promise.resolve();
    }

    public eventFailed(payload: EventFired<any>,
                       ctx: HandlerContext,
                       err: any): Promise<any> {
        this.sendOperation("EventHandler", "operation", "event-handler",
            payload.extensions.operationName, "failed", (ctx as any as AutomationContextAware).context, err);
        return Promise.resolve();
    }

    public messageSent(message: any,
                       destinations: Destination | Destination[],
                       options: MessageOptions,
                       ctx: HandlerContext) {
        this.sendEvent(
            "Outgoing message",
            "message",
            {
                message,
                destinations,
                options,
            },
            (ctx as any as AutomationContextAware).context);
    }

    private sendOperation(identifier: string,
                          eventType: string,
                          type: string,
                          name: string,
                          status: string,
                          ctx: AutomationContext,
                          err?: any) {
        if (!ctx) {
            return;
        }
        const start = ctx.ts;
        const data: any = {
            "operation-type": type,
            "operation-name": name,
            "artifact": ctx.name,
            "version": ctx.version,
            "team-id": ctx.teamId,
            "team-name": ctx.teamName,
            "event-type": eventType,
            "level": status === "failed" ? "error" : "info",
            status,
            "execution-time": Date.now() - start,
            "correlation-id": ctx.correlationId,
            "invocation-id": ctx.invocationId,
            "message": `${identifier} ${name} invocation ${status} for ${ctx.teamName} '${ctx.teamId}'`,
        };
        if (err) {
            if (status === "failed") {
                data.stacktrace = serializeError(err);
            } else if (status === "successful") {
                data.result = serializeError(err);
            }
        }
        if (this.logzio) {
            this.logzio.log(data);
        }
    }

    private sendEvent(identifier: string,
                      type: string,
                      payload: any,
                      ctx: AutomationContext) {
        if (!ctx) {
            return;
        }
        const data = {
            "operation-name": ctx.operation,
            "artifact": ctx.name,
            "version": ctx.version,
            "team-id": ctx.teamId,
            "team-name": ctx.teamName,
            "event-type": type,
            "level": "info",
            "correlation-id": ctx.correlationId,
            "invocation-id": ctx.invocationId,
            "message": `${identifier} of ${ctx.operation} for ${ctx.teamName} '${ctx.teamId}'`,
            "payload": JSON.stringify(payload),
        };
        if (this.logzio) {
            this.logzio.log(data);
        }
    }

    private initLogzioLogging(options: LogzioOptions) {

        const logzioOptions = {
            token: options.token,
            level: "debug",
            type: "automation-client",
            protocol: "https",
            bufferSize: 10,
            extraFields: {
                "service": options.name,
                "artifact": options.name,
                "version": options.version,
                "environment": options.environment,
                "application-id": options.application,
                "process-id": process.pid,
                "host": os.hostname(),
            },
        };
        // create the logzio event logger
        this.logzio = require("logzio-nodejs").createLogger(logzioOptions);

        const logzioWinstonTransport = require("winston-logzio");

        // tslint:disable:no-parameter-reassignment
        logzioWinstonTransport.prototype.log = function(level: any, msg: any, meta: any, callback: any) {

            if (typeof msg !== "string" && typeof msg !== "object") {
                msg = { message: this.safeToString(msg) };
            } else if (typeof msg === "string") {
                msg = { message: msg };
            }

            if (meta instanceof Error) {
                meta = { error: meta.stack || meta.toString() };
            }

            if (nsp && nsp.get()) {
                _.assign(msg, {
                    level,
                    "meta": meta,
                    "operation-name": nsp.get().operation,
                    "artifact": nsp.get().name,
                    "version": nsp.get().version,
                    "team-id": nsp.get().teamId,
                    "team-name": nsp.get().teamName,
                    "correlation-id": nsp.get().correlationId,
                    "invocation-id": nsp.get().invocationId,
                });
            } else {
                _.assign(msg, {
                    level,
                    meta,
                });
            }

            this.logzioLogger.log(msg);

            callback(null, true);
        };

        // create the winston logging adapter
        (logger as any).add(logzioWinstonTransport, logzioOptions);

    }
}

/**
 * Configure logzio logging if token exists in configuration.
 */
export function configureLogzio(configuration: Configuration): Promise<Configuration> {
    if (_.get(configuration, "logzio.enabled") === true) {
        logger.debug(`Adding Logz.io listener`);

        const token = _.get(configuration, "logzio.token");
        if (!token) {
            throw new Error("Logz.io token is missing. Please set 'logzio.token' in your configuration.");
        }

        try {
            require("logzio-nodejs");
        } catch (err) {
            throw new Error("Logz.io can't be loaded. Please install with 'npm install logzio-nodejs --save'.");
        }

        try {
            require("winston-logzio");
        } catch (err) {
            throw new Error("Logz.io can't be loaded. Please install with 'npm install winston-logzio --save'.");
        }

        const options: LogzioOptions = {
            token: configuration.logzio.token,
            name: configuration.name,
            version: configuration.version,
            environment: configuration.environment,
            application: configuration.application,
        };

        configuration.listeners.push(new LogzioAutomationEventListener(options));
    }
    return Promise.resolve(configuration);
}
