FROM public.ecr.aws/lambda/nodejs:14@sha256:209eaa0ac09c930273a46e4bf1b5bac729e04ccc6f8fb9943cb26e2028c67fde
ARG strapiUrl
ARG publicAdminUrl
ENV NODE_ENV production
ENV STRAPI_URL ${strapiUrl}
ENV STRAPI_ADMIN_URL ${publicAdminUrl}
WORKDIR /var/task/
RUN npm i -g yarn
COPY package.json yarn.lock ./
RUN yarn --prod --frozen-lockfile
COPY favicon.ico lambda.js ./
COPY api ./api
# COPY components ./components
COPY config ./config
COPY extensions ./extensions
CMD ["lambda.handler"]
