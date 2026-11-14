= TODO
A local html website, that manages the alternative art design process for a magic the gathering deck.

I need the following functionality:

I need to be able to drop in the list of a commander deck for magic the gathering,
pull all the card images from the internet (for example via scryfall etc.)
Ideally this locally caches them in a subfolder.
I then need to be able to scroll though them and create alternative art and title proxies.
So when clicking on a card, on the right a window should fill in with a template of the card but i want to be able to name it as i want and i want to add my own art via drop in and maybe a very rudimentary rotating / cutting tool etc.
I am thinking about something like implemented in https://www.mtgproxy.net/designer with the subtitles, choose color etc. but it should already copy everything from the original card, if i replace the name, the original name should go as the subtitle below the title similar to like on the website.
The original name should be as a subtitle. I want to be able to drop in the new art and it should just be replaced. Full art etc should also be possible.

Ideally there is then another subfolder for all the remade cards and one config file, that records like the new alternative names and so on, tracked by git for people to work together on this.