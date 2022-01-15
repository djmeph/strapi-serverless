FROM ubuntu:20.04 as base
WORKDIR /src
ENV DEBIAN_FRONTEND="noninteractive"

COPY .bashrc .profile .git-completion /root/

RUN apt-get update && apt-get install -y curl build-essential vim nano git unzip
RUN curl -sL https://deb.nodesource.com/setup_14.x | bash -
RUN apt-get install -y nodejs
RUN npm i -g yarn
RUN yarn global add aws-cdk

RUN curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip" \
  && unzip awscliv2.zip \
  && ./aws/install
