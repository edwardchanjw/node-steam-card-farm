/* Get settings from the file */
var settings = require('./config/settings.js');

/* Set up logging */
var Winston = require('winston');
var logger = new (Winston.Logger)({
    transports: [
        new (Winston.transports.Console)({
            colorize: true,
            level: settings.logger.console
        }),
        new (Winston.transports.File)({
            level: settings.logger.file,
            timestamp: true,
            filename: 'error.log',
            json: false
        })
    ]
});

/* Load steam modules */
var SteamUser = require('steam-user');
var SteamTotp = require('steam-totp');
var SteamCommunity = require('steamcommunity');
var TradeOfferManager = require('steam-tradeoffer-manager');

/* Load file stream module to process poll data */
var fs = require('fs');

/* Load request and cheerio to parse steam badges page */
var Cheerio = require('cheerio');

/* Read bots list */
var bots = {};
settings.bots.forEach(function(bot) {
    /* Make sure bot object is defined properly and it's active */
    if (bot.enabled && typeof bot.steamid === 'string' && typeof bot.username === 'string' && typeof bot.password === 'string') {
        /* Add bot to local list */
        bots[bot.steamid] = {
            name: bot.name || bot.steamid,
            username: bot.username,
            password: bot.password,
            shared_secret: bot.shared_secret,
            idle: bot.idle || true,
            bot: new SteamUser(),
            community: new SteamCommunity(),
            offers: (!bot.trades ? null : new TradeOfferManager({
                steam: this.bot,
                domain: settings.domain,
                language: "en",
                pollInterval: 20000,
                cancelTime: 450000
            })),
            active: false,
            idling: null,
            apps: {}
        };
    }
});

/* Bot functions */
function botRedeemKey(botid, key, callback) {
    /* [TODO: Update and use this if node-steam-user's poll request #36 accepted] */
    bots[botid].bot.redeemKey(key, function(result, details, apps) {
        if(details === SteamUser.EPurchaseResult.OK) {
            updateGames(botid);
            callback(null, botid,apps);
            return;
        }

        callback(details, botid);
    });
}

function farmRedeemKey(key, callback) {
    /* [TODO: Update and use this if node-steam-user's poll request #36 accepted] */
    /* [TODO: Check if the bot already owns the game instead of blind testing] */
    var bot_ids = Object.keys(bots);

    var code_callback = function(err, botid, apps) {
        if (err) {
            switch (err) {
                case SteamUser.EPurchaseResult.InvalidKey:
                case SteamUser.EPurchaseResult.DuplicatedKey:
                case SteamUser.EPurchaseResult.RegionLockedKey:
                    if(typeof callback === 'function') {
                        callback(err);
                    }
                    break;
                case SteamUser.EPurchaseResult.AlreadyOwned:
                case SteamUser.EPurchaseResult.BaseGameRequired:
                case SteamUser.EPurchaseResult.OnCooldown:
                    bot_ids.splice(bot_ids.indexOf(botid), 1);
                    if (bot_ids.length > 0) {
                        botRedeemKey(bot_ids[0], key, code_callback);
                    } else {
                        if (err === SteamUser.EPurchaseResult.OnCooldown) {
                            callback(null, 'Key activation on cooldown or/and already owned by all bots!');
                        } else {
                            callback(null, 'Already owned by all bots!');
                        }
                    }
                    break;
            }
        } else {
            logger.info('[' + bots[botid].name + '] Activated new key! New packets: ' + apps.map(function(index) {
                     return apps[index].game_extra_info;
                 }).join(', '));
        }
    };

    botRedeemKey(bot_ids[0], key, code_callback);
}

function idleGame(botid, gameid) {
    /* Check if bot is ndisabled from idling */
    if(bots[botid].idle) {
        /* Check if gameid is number or not */
        if (!isNaN(parseInt(gameid))) {
            gameid = parseInt(gameid);
        }

        bots[botid].bot.gamesPlayed(gameid);
        bots[botid].idling = gameid;
        logger.info('[' + bots[botid].name + '] Started idling: ' + gameid);
        logger.debug('[' + bots[botid].name + '] Game name: ' + bots[botid].apps[gameid].name + ', cards left: ' + bots[botid].apps[gameid].drops + ', playtime: ' + bots[botid].apps[gameid].playtime);
    }
}

function stopIdle(botid) {
    bots[botid].bot.gamesPlayed();
    bots[botid].idling = null;
    logger.verbose('[' + bots[botid].name + '] Stopped idling');
}

function processMessage(botid, senderid, message) {
    /* Check if message sender is one of bot admins */
    if (settings.botAdmins.indexOf(senderid.getSteamID64()) > -1) {
        logger.verbose('[' + bots[botid].name + '] Received message from bot admin: ' + message);
        if (message.substr(0, 1) === '!') {
            var command = message.split(' ')[0].substring(1).toLowerCase();
            switch (command) {
                case 'help':
                    bots[botid].bot.chatMessage(senderid, 'Available commands: !help, !info, !stats, !status, !botidle <appid>, !botstop, !botstart, !botrefresh, !farmidle <appid>, !farmrefresh');
                    bots[botid].bot.chatMessage(senderid, 'Check details here: https://github.com/Aareksio/node-steam-card-farm');
                    break;
                case 'info':
                    bots[botid].bot.chatMessage(senderid, 'Steam Cards Farm v0.1.0 (2015-12-15)');
                    bots[botid].bot.chatMessage(senderid, 'Report bugs here: https://github.com/Aareksio/node-steam-card-farm/issues');
                    break;
                case 'status':
                    bots[botid].bot.chatMessage(senderid, 'Games left to idle: ' + Object.keys(bots[botid].apps).length);
                    break;
                case 'stats':
                    Object.keys(bots).forEach(function(id) {
                        if (bots.hasOwnProperty(id)) {
                            bots[botid].bot.chatMessage(senderid, '[' + bots[id].name + '] Games left to idle: ' + Object.keys(bots[id].apps).length);
                        }
                    });
                    break;
                case 'botidle':
                    var game = message.split(' ')[1];
                    idleGame(botid, game);
                    bots[botid].bot.chatMessage(senderid, 'Started idling ' + game);
                    break;
                case 'farmidle':
                    var all_game = message.split(' ')[1];
                    farmIdle(all_game);
                    bots[botid].bot.chatMessage(senderid, 'All bots with the game started idling: ' + all_game);
                    break;
                case 'botstop':
                    stopIdle(botid, game);
                    bots[botid].bot.chatMessage(senderid, 'Stopped idling');
                    break;
                case 'botstart':
                case 'botrefresh':
                    bots[botid].bot.chatMessage(senderid, 'Refreshing the bot!');
                    updateGames(botid, function(err) {
                        if(err) {
                            bots[botid].bot.chatMessage(senderid, 'Error! ' + err);
                        } else {
                            bots[botid].bot.chatMessage(senderid, 'Done!');
                        }
                    });
                    break;
                case 'farmrefresh':
                    bots[botid].bot.chatMessage(senderid, 'Refreshing all bots!');
                    Object.keys(bots).forEach(function(id) {
                        if (bots.hasOwnProperty(id)) {
                            updateGames(id, function(err) {
                                if(err) {
                                    bots[id].bot.chatMessage(senderid, 'Error! ' + err);
                                }
                            });
                        }
                    });
                    break;
                case 'ping':
                    bots[botid].bot.chatMessage(senderid, 'Pong!');
                    break;
                default:
                    bots[botid].bot.chatMessage(senderid, 'Unknown command, try: !help');
            }
        }
    } else {
        logger.verbose('[' + bots[botid].name + '] Received unauthorized message: ' + message);
    }
}

function loadBadges(botid, page, apps, callback) {
    apps = apps || {};
    page = page || 1;

    /* Use steamcommunity module to access badges page */
    bots[botid].community.request('https://steamcommunity.com/my/badges/?p=' + page, function(err, response, body) {
        /* Check for invalid response */
        if (err || response.statusCode != 200) {
            logger.warn('Error updating badges page: ' + (err || "HTTP" + response.statusCode));
            if (typeof callback === 'function') {
                callback((err || "HTTP" + response.statusCode));
                return;
            }
        }

        /* Do some parse magic */
        var $ = Cheerio.load(body);

        $('.badge_row').each(function () { // For each badge...
            var row = $(this);

            var overlay = row.find('.badge_row_overlay'); // Get it's inner content...
            if (!overlay) { // Well done!
                return;
            }

            var match = overlay.attr('href').match(/\/gamecards\/(\d+)/); // Get game appid...
            if (!match) { // Well done!
                return;
            }

            var appid = parseInt(match[1], 10);

            /* [TODO: Check when the packet was bought and don't idle it without permission] */

            var name = row.find('.badge_title');
            name.find('.badge_view_details').remove();
            name = name.text().replace(/\n/g, '').replace(/\r/g, '').replace(/\t/g, '').trim();

            var drops = row.find('.progress_info_bold').text().match(/(\d+) card drops remaining/);
            if (!drops) { // Nothing to do here!
                return;
            }

            drops = parseInt(drops[1], 10);
            if (isNaN(drops) || drops < 1) { // Well done!
                return;
            }

            var playtime = row.find('.badge_title_stats').html().match(/(\d+\.\d+) hrs on record/);
            if (!playtime) {
                playtime = 0.0;
            } else {
                playtime = parseFloat(playtime[1], 10);
                if (isNaN(playtime)) { // Well done!
                    playtime = 0.0;
                }
            }

            apps[appid] = {
                name: name,
                drops: drops,
                playtime: playtime
            }
        });

        var pagelinks = $('.pageLinks').first();
        if(pagelinks.html() == null) {
            callback(apps);
            return;
        }

        pagelinks.find('.pagebtn').each(function() {
            var button = $(this);
            if (button.text() === '>') {
                if(button.hasClass('disabled')) {
                    callback(apps);
                } else {
                    loadBadges(botid, page + 1, apps, callback);
                }
            }
        });
    });
}

function updateGames(botid, callback) {
    if(!bots[botid].community.steamID) {
        if (typeof callback === 'function') {
            callback('Not logged in!');
        }
        return;
    }

    var apps = {};

    loadBadges(botid, 1, apps, function(apps) {
        /* Save the data */
        bots[botid].apps = apps;

        /* Check if there's any game to idle */
        if (Object.keys(apps).length > 0) {
            /* Check if the bot is not idling the game already */
            if (!bots[botid].idling || !apps.hasOwnProperty(bots[botid].idling)) {
                /* Get first element on the list and idle the game */
                /* [TODO: Add different sort algorithms] */
                idleGame(botid, Object.keys(apps)[0]);
            }
        } else {
            /* Stop idling if no cards left */
            /* [TODO: Switch to offline?] */
            if (bots[botid].idling) {
                stopIdle(botid);
            }
        }

        if (typeof callback === 'function') {
            callback(null);
        }
    });
}

function farmIdle(gameid) {
    Object.keys(bots).forEach(function(botid) {
        if (bots.hasOwnProperty(botid)) {
            if (Object.keys(bots[botid].apps).indexOf(gameid) > -1) {
                idleGame(botid, gameid);
            }
        }
    });
}

/* Initialize bots */

Object.keys(bots).forEach(function(botid) {
    if (bots.hasOwnProperty(botid)) {
        /* Login to steam */
        bots[botid].bot.logOn({
            accountName: bots[botid].username,
            password: bots[botid].password,
            twoFactorCode: (bots[botid].shared_secret ? SteamTotp.generateAuthCode(bots[botid].shared_secret) : null)
        });

        bots[botid].bot.on('loggedOn', function(details) {
            logger.info('[' + bots[botid].name + '] Logged into Steam!');
            bots[botid].bot.setPersona(SteamUser.Steam.EPersonaState.Online);
        });

        bots[botid].bot.on('disconnected', function(details) {
            logger.info('[' + bots[botid].name + '] Disconnected from Steam! Reason: ' + details);
            bots[botid].active = false;
        });

        /* Handle errors */
        bots[botid].bot.on('error', function(e) {
            /* [TODO: Handle errors like LogonSessionReplaced] */
            switch(e) {
                case SteamUser.Steam.EResult.InvalidPassword:
                    logger.error('[' + bots[botid].name + '] Invalid password!');
                    break;
                default:
                    logger.error(e);
            }
        });

        /* Get web session */
        bots[botid].bot.on('webSession', function (sessionID, cookies) {
            logger.verbose('[' + bots[botid].name + '] Got web session');

            /* Initialize steamcommunity module by setting cookies */
            bots[botid].community.setCookies(cookies);

            /* Do the same with trade module */
            if(bots[botid].offers !== null) {
                bots[botid].offers.setCookies(cookies, function (err){
                    if (!err) {
                        logger.verbose('[' + bots[botid].name + '] Trade offer cookies set. Got API Key: '+ bots[botid].offers.apiKey);
                    } else {
                        logger.error('[' + bots[botid].name + '] Unable to set trade offer cookies: ' + err);
                    }
                });
            }

            bots[botid].active = true;
            updateGames(botid); // Start idle
            if (settings.stats) {
                bots[botid].bot.joinChat('103582791440699799');
            }
        });

        /* Check for limitations */
        /* [TODO: Disable bot if trade is impossible] */
        bots[botid].bot.on('accountLimitations', function (limited, communityBanned, locked, canInviteFriends) {
            if (limited) { logger.warn('[' + bots[botid].name + '] Account limited!'); }
            if (communityBanned){ logger.warn('[' + bots[botid].name + '] Account banned from Steam Community!'); }
            if (locked){ logger.error('[' + bots[botid].name + '] Account locked! Can\'t trade!'); }
            if (!canInviteFriends){ logger.warn('[' + bots[botid].name + '] Account can not add any friends!'); }
        });

        bots[botid].bot.on('friendMessage', function(senderID, message) {
            processMessage(botid, senderID, message);
        });

        bots[botid].bot.on('newItems', function(count) {
            /* Check for any card drops left */
            updateGames(botid);
        });

        if (bots[botid].offers !== null) {
            fs.readFile('polldata/' + botid + '.json', function (err, data) {
                if (err) {
                    logger.verbose('[' + bots[botid].name + '] No polldata/' + botid + '.json found.');
                } else {
                    logger.debug('[' + bots[botid].name + '] Found previous pool data.');
                    bots[botid].offers.pollData = JSON.parse(data);
                }
            });

            /* Process trade offers sent by bot admin */
            bots[botid].offers.on('newOffer', function (offer) {
                logger.info('[' + bots[botid].name + '] New offer #' + offer.id + ' from ' + offer.partner.getSteam3RenderedID());
                if (settings.botAdmins.indexOf(offer.partner.getSteamID64()) !== -1) {
                    logger.info('[' + bots[botid].name + '] Admin ('+ offer.partner.getSteam3RenderedID() +') offered a trade. Attempting to accept.');
                    offer.accept(function (err) {
                        if (err) {
                            logger.warn('[' + bots[botid].name + '] Unable to accept offer #'+ offer.id +': ' + err.message);
                        } else {
                            logger.verbose('[' + bots[botid].name + '] Offer # ' + offer.id + ' accepted!');
                        }
                    });
                } else {
                    logger.verbose('[' + bots[botid].name + '] User ' + offer.partner.getSteam3RenderedID() + ' offered an invalid trade. Declining.');
                    offer.decline(function (err) {
                        if (err) {
                            logger.warn('[' + bots[botid].name + '] Unable to decline offer #' + offer.id + ': ' + err.message);
                        } else {
                            logger.verbose('[' + bots[botid].name + '] Offer #' + offer.id + ' declined!');
                        }
                    });
                }
            });

            /* Display changes in active offers */
            bots[botid].offers.on('receivedOfferChanged', function (offer, oldState) {
                logger.verbose('[' + bots[botid].name + '] ' + offer.partner.getSteam3RenderedID() +' offer #' + offer.id + ' changed: ' + TradeOfferManager.getStateName(oldState) + ' -> ' + TradeOfferManager.getStateName(offer.state));
            });

            bots[botid].offers.on('sentOfferChanged', function (offer, oldState) {
                logger.verbose('[' + bots[botid].name + '] ' + offer.partner.getSteam3RenderedID() +' offer #' + offer.id + ' changed: ' + TradeOfferManager.getStateName(oldState) + ' -> ' + TradeOfferManager.getStateName(offer.state));
            });

            /* Save poll data for future use */
            bots[botid].offers.on('pollFailure', function (err) {
                logger.error('[' + bots[botid].name + ']  Poll data ' + err);
            });

            bots[botid].offers.on('pollData', function (pollData) {
                fs.writeFile('polldata/' + botid + '.json', JSON.stringify(pollData));
            });
        }
    }
});