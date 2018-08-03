'use strict';

var request = require('request');

function CurrencyController(options) {
  this.node = options.node;
  var refresh = options.currencyRefresh || CurrencyController.DEFAULT_CURRENCY_DELAY;
  this.currencyDelay = refresh * 60000;
  this.bitstampRate = 0; // USD/BTC
  this.coinlibRate = 0; // BTC/SAFE Coinlib.io
  this.timestamp = Date.now();
}

CurrencyController.DEFAULT_CURRENCY_DELAY = 10;

CurrencyController.prototype.index = function(req, res) {
  var self = this;
  var currentTime = Date.now();
  if (self.bitstampRate === 0 || currentTime >= (self.timestamp + self.currencyDelay)) {
    self.timestamp = currentTime;
    request('https://www.bitstamp.net/api/ticker/', function(err, response, body) {
      if (err) {
        self.node.log.error(err);
      }
      if (!err && response.statusCode === 200) {
        self.bitstampRate = parseFloat(JSON.parse(body).last);
      }
      request('https://coinlib.io/api/v1/coin?key=d437271814700b9a&pref=BTC&symbol=SAFE', function (err, response, body) {
        if (err) {
          self.node.log.error(err);
        }
        if (!err && response.statusCode === 200) {
            var coindata = JSON.parse(body);
          self.coinlibRate = parseFloat(coindata['price']);
        }
        res.jsonp({
          status: 200,
          data: {
            bitstamp: self.bitstampRate * self.coinlibRate
          }
        });
      });
    });
  } else {
    res.jsonp({
      status: 200,
      data: { 
        bitstamp: self.bitstampRate * self.coinlibRate
      }
    });
  }

};

module.exports = CurrencyController;