'use strict';

var async = require('async');
var bitcore = require('bitcore-lib-safecoin');
var _ = bitcore.deps._;
var pools = require('../pools.json');
var BN = bitcore.crypto.BN;
var LRU = require('lru-cache');
var Common = require('./common');

function BlockController(options) {
  var self = this;
  this.node = options.node;

  this.blockSummaryCache = LRU(options.blockSummaryCacheSize || BlockController.DEFAULT_BLOCKSUMMARY_CACHE_SIZE);
  this.blockCacheConfirmations = 6;
  this.blockCache = LRU(options.blockCacheSize || BlockController.DEFAULT_BLOCK_CACHE_SIZE);

  this.poolStrings = {};
  pools.forEach(function(pool) {
    pool.searchStrings.forEach(function(s) {
      self.poolStrings[s] = {
        poolName: pool.poolName,
        url: pool.url
      };
    });
  });

  this.common = new Common({log: this.node.log});
}

var BLOCK_LIMIT = 200;

BlockController.DEFAULT_BLOCKSUMMARY_CACHE_SIZE = 1000000;
BlockController.DEFAULT_BLOCK_CACHE_SIZE = 1000;

function isHexadecimal(hash) {
  if (!_.isString(hash)) {
    return false;
  }
  return /^[0-9a-fA-F]+$/.test(hash);
}

BlockController.prototype.checkBlockHash = function(req, res, next) {
  var self = this;
  var hash = req.params.blockHash;
  if (hash.length < 64 || !isHexadecimal(hash)) {
    return self.common.handleErrors(null, res);
  }
  next();
};

/**
 * Find block by hash ...
 */
BlockController.prototype.block = function(req, res, next) {
  var self = this;
  var hash = req.params.blockHash;
  var blockCached = self.blockCache.get(hash);

  if (blockCached) {
    blockCached.confirmations = self.node.services.bitcoind.height - blockCached.height + 1;
    req.block = blockCached;
    next();
  } else {
    self.node.getBlock(hash, function(err, block) {
      if((err && err.code === -5) || (err && err.code === -8)) {
        return self.common.handleErrors(null, res);
      } else if(err) {
        return self.common.handleErrors(err, res);
      }
      self.node.services.bitcoind.getBlockHeader(hash, function(err, info) {
        if (err) {
          return self.common.handleErrors(err, res);
        }
        var blockResult = self.transformBlock(block, info);
        if (blockResult.confirmations >= self.blockCacheConfirmations) {
          self.blockCache.set(hash, blockResult);
        }
        req.block = blockResult;
        next();
      });
    });
  }
};

/**
 * Find rawblock by hash and height...
 */
BlockController.prototype.rawBlock = function(req, res, next) {
  var self = this;
  var blockHash = req.params.blockHash;

  self.node.getRawBlock(blockHash, function(err, blockBuffer) {
    if((err && err.code === -5) || (err && err.code === -8)) {
      return self.common.handleErrors(null, res);
    } else if(err) {
      return self.common.handleErrors(err, res);
    }
    req.rawBlock = {
      rawblock: blockBuffer.toString('hex')
    };
    next();
  });

};

BlockController.prototype._normalizePrevHash = function(hash) {
  // TODO fix bitcore to give back null instead of null hash
  if (hash !== '0000000000000000000000000000000000000000000000000000000000000000') {
    return hash;
  } else {
    return null;
  }
};

BlockController.prototype.transformBlock = function(block, info) {
  var blockObj = block.toObject();
  var transactionIds = blockObj.transactions.map(function(tx) {
    return tx.hash;
  });
  return {
    hash: block.hash,
    size: block.toBuffer().length,
    height: info.height,
    version: blockObj.header.version,
    merkleroot: blockObj.header.merkleRoot,
    tx: transactionIds,
    time: blockObj.header.time,
    nonce: blockObj.header.nonce,
    solution: blockObj.header.solution,
    bits: blockObj.header.bits.toString(16),
    difficulty: block.header.getDifficulty(),
    chainwork: info.chainWork,
    confirmations: info.confirmations,
    previousblockhash: this._normalizePrevHash(blockObj.header.prevHash),
    nextblockhash: info.nextHash,
    reward: this.getBlockReward(info.height) / 1e8,
    isMainChain: (info.confirmations !== -1),
    poolInfo: this.getPoolInfo(block)
  };
};

/**
 * Show block
 */
BlockController.prototype.show = function(req, res) {
  if (req.block) {
    res.jsonp(req.block);
  }
};

BlockController.prototype.showRaw = function(req, res) {
  if (req.rawBlock) {
    res.jsonp(req.rawBlock);
  }
};

BlockController.prototype.blockIndex = function(req, res) {
  var self = this;
  var height = req.params.height;
  this.node.services.bitcoind.getBlockHeader(parseInt(height), function(err, info) {
    if (err) {
      return self.common.handleErrors(err, res);
    }
    res.jsonp({
      blockHash: info.hash
    });
  });
};

BlockController.prototype._getBlockSummary = function(hash, moreTimestamp, next) {
  var self = this;

  function finish(result) {
    if (moreTimestamp > result.time) {
      moreTimestamp = result.time;
    }
    return next(null, result);
  }

  var summaryCache = self.blockSummaryCache.get(hash);

  if (summaryCache) {
    finish(summaryCache);
  } else {
    self.node.services.bitcoind.getRawBlock(hash, function(err, blockBuffer) {
      if (err) {
        return next(err);
      }

      var br = new bitcore.encoding.BufferReader(blockBuffer);

      // take a shortcut to get number of transactions and the blocksize.
      // Also reads the coinbase transaction and only that.
      // Old code parsed all transactions in every block _and_ then encoded
      // them all back together to get the binary size of the block.
      // FIXME: This code might still read the whole block. Fixing that
      // would require changes in bitcore-node.
      var header = bitcore.BlockHeader.fromBufferReader(br);
      var info = {};
      var txlength = br.readVarintNum();
      info.transactions = [bitcore.Transaction().fromBufferReader(br)];

      self.node.services.bitcoind.getBlockHeader(hash, function(err, blockHeader) {
        if (err) {
          return next(err);
        }
        var height = blockHeader.height;

        var summary = {
          height: height,
          size: blockBuffer.length,
          hash: hash,
          time: header.time,
          txlength: txlength,
          poolInfo: self.getPoolInfo(info)
        };

        var confirmations = self.node.services.bitcoind.height - height + 1;
        if (confirmations >= self.blockCacheConfirmations) {
          self.blockSummaryCache.set(hash, summary);
        }

        finish(summary);
      });
    });

  }
};

// List blocks by date
BlockController.prototype.list = function(req, res) {
  var self = this;

  var dateStr;
  var todayStr = this.formatTimestamp(new Date());
  var isToday;

  if (req.query.blockDate) {
    dateStr = req.query.blockDate;
    var datePattern = /\d{4}-\d{2}-\d{2}/;
    if(!datePattern.test(dateStr)) {
      return self.common.handleErrors(new Error('Please use yyyy-mm-dd format'), res);
    }

    isToday = dateStr === todayStr;
  } else {
    dateStr = todayStr;
    isToday = true;
  }

  var gte = Math.round((new Date(dateStr)).getTime() / 1000);

  //pagination
  var lte = parseInt(req.query.startTimestamp) || gte + 86400;
  var prev = this.formatTimestamp(new Date((gte - 86400) * 1000));
  var next = lte ? this.formatTimestamp(new Date(lte * 1000)) : null;
  var limit = parseInt(req.query.limit || BLOCK_LIMIT);
  var more = false;
  var moreTimestamp = lte;

  self.node.services.bitcoind.getBlockHashesByTimestamp(lte, gte, function(err, hashes) {
    if(err) {
      return self.common.handleErrors(err, res);
    }

    hashes.reverse();

    if(hashes.length > limit) {
      more = true;
      hashes = hashes.slice(0, limit);
    }

    async.mapSeries(
      hashes,
      function(hash, next) {
        self._getBlockSummary(hash, moreTimestamp, next);
      },
      function(err, blocks) {
        if(err) {
          return self.common.handleErrors(err, res);
        }

        blocks.sort(function(a, b) {
          return b.height - a.height;
        });

        var data = {
          blocks: blocks,
          length: blocks.length,
          pagination: {
            next: next,
            prev: prev,
            currentTs: lte - 1,
            current: dateStr,
            isToday: isToday,
            more: more
          }
        };

        if(more) {
          data.pagination.moreTs = moreTimestamp;
        }

        res.jsonp(data);
      }
    );
  });
};

BlockController.prototype.getPoolInfo = function(block) {
  var coinbaseBuffer = block.transactions[0].inputs[0]._scriptBuffer;

  for(var k in this.poolStrings) {
    if (coinbaseBuffer.toString('utf-8').match(k)) {
      return this.poolStrings[k];
    }
  }

  return {};
};

//helper to convert timestamps to yyyy-mm-dd format
BlockController.prototype.formatTimestamp = function(date) {
  var yyyy = date.getUTCFullYear().toString();
  var mm = (date.getUTCMonth() + 1).toString(); // getMonth() is zero-based
  var dd = date.getUTCDate().toString();

  return yyyy + '-' + (mm[1] ? mm : '0' + mm[0]) + '-' + (dd[1] ? dd : '0' + dd[0]); //padding
};

BlockController.prototype.getBlockReward = function(height) {
// genesis block
  if (height == 0) {
  	return 0;
  }
  if (height == 1) {
  	return new BN(4000000 * 1e8);
  }
  if (height == 80185) {
  	return new BN(665600 * 1e8); //refund for interest rate attack
  }
  if (height < 123840) {
  	return new BN(128 * 1e8);
  }
  if (height < 178378) {
  	return new BN(64 * 1e8);
  }
  if (height < 181378) {
  	return new BN(56 * 1e8);
  }
  if (height < 184378) {
  	return new BN(48 * 1e8);
  }
  if (height < 187378) {
  	return new BN(40 * 1e8);
  }
  if (height < 197378) {
  	return new BN(32 * 1e8);
  }
  if (height < 207378) {
  	return new BN(28 * 1e8);
  }
  if (height < 217378) {
  	return new BN(24 * 1e8);
  }
  if (height < 227378) {
  	return new BN(22 * 1e8);
  }
  if (height < 237378) {
  	return new BN(20 * 1e8);
  }
  if (height < 247378) {
  	return new BN(18 * 1e8);
  }
  if (height < 287378) {
  	return new BN(16 * 1e8);
  }
  if (height < 327378) {
  	return new BN(15 * 1e8);
  }
  if (height < 367378) {
  	return new BN(14 * 1e8);
  }
  if (height < 407378) {
  	return new BN(13 * 1e8);
  }
  if (height < 447378) {
  	return new BN(12 * 1e8);
  }
  if (height < 487378) {
  	return new BN(11 * 1e8);
  }
  if (height < 527378) {
  	return new BN(10 * 1e8);
  }
  if (height < 567378) {
  	return new BN(9 * 1e8);
  }
  if (height < 647378) {
  	return new BN(8 * 1e8);
  }
  if (height < 727378) {
  	return new BN(7 * 1e8);
  }
  if (height < 807378) {
  	return new BN(6 * 1e8);
  }
  if (height < 887378) {
  	return new BN(5 * 1e8);
  }
  if (height < 1207378) {
  	return new BN(4 * 1e8);
  }
  if (height < 1527378) {
  	return new BN(3 * 1e8);
  }
  if (height < 1847378) {
  	return new BN(2 * 1e8);
  }
  if (height < 2167378) {
  	return new BN(1 * 1e8);
  }
  if (height < 3447378) {
  	return new BN(0.5 * 1e8);
  }
  if (height < 4727378) {
  	return new BN(0.25 * 1e8);
  }
  if (height < 5256000) {
  	return new BN(0.125 * 1e8); // 10 Year Mark, Safecoin to implement POS prior to this
  } 
};

module.exports = BlockController;
