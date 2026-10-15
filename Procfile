# Railway (and any Heroku-style host) reads this to know how to run the service.
#
# A single long-lived process, which is the point: the price feed ticks on an
# interval and the trading socket is a persistent connection, so this workload
# cannot run on a serverless platform.
web: node tools/server.mjs
